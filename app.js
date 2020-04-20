// Imports
require('dotenv').config({ path: __dirname + '/.env' })
const { CoinbasePro, WebSocketChannelName, WebSocketEvent } = require('coinbase-pro-node');
const { IncomingWebhook } = require('@slack/webhook');
const Helpers = require('./helpers');
const DB = require('./db');

// Percentages
const percentToReBuy  = Number(process.env['PERCENT_TO_RE_BUY']); // Buy when the last bought INACTIVE value is below this percentage
const percentToBuy    = Number(process.env['PERCENT_TO_BUY']); // Buy when the last bought ACTIVE value is above this percentage
const percentToSell   = Number(process.env['PERCENT_TO_SELL']); // Sell when sell value is at least this percentage from the lowest buy value
const percentSecurity = Number(process.env['PERCENT_SECURITY']); // Sell when the buy value drops below this percentage from his highest stored value
const percentFee      = Number(process.env['PERCENT_FEE']); // Percentage fee

// Base trading values
const productIds    = process.env["PRODUCT_IDS"].split(' | ');
const tradeValue    = Number(process.env['TRADE_VALUE']); // Value, in currency, to trade each time we need to buy
const tradeValueRe  = Number(process.env['TRADE_VALUE_RE']); // Value, in currency, to trade each time we need to buy (only if RE BUY)

// Trading Info
let wallets = [];

// Inits the Coinbase Client
const client = new CoinbasePro({
  apiKey: process.env['COINBASE_API_KEY'],
  apiSecret: process.env['COINBASE_API_SECRET'],
  passphrase: process.env['COINBASE_API_PASSPHRASE'],
  useSandbox: process.env['COINBASE_API_SANDBOX'],
});

// Inits the Slack notification WebHook
const webHook = new IncomingWebhook(process.env['SLACK_NOTIFICATION_URL']);

// Update the wallet
updateWallet();
function updateWallet() {
  wallets = [];
  client.rest.account.listAccounts().then(accounts => {
    accounts.forEach(_account => wallets[_account.currency] = Number(_account.balance));
  });
}

// Connect to the WebSocket
client.ws.connect().then().catch(() => {});

// WebSocket Subscriptions
client.ws.subscribe([{
  name: WebSocketChannelName.HEARTBEAT,
  product_ids: productIds
}, {
  name: WebSocketChannelName.TICKER,
  product_ids: productIds
}]);

// Init timer (this will be used to check if the websocket is still alive)
let heartBeats = {}; productIds.forEach(product => heartBeats[product] = 0);
setInterval(_ => {
  Object.keys(heartBeats).forEach(product => {if (heartBeats[product]++ > 30) { process.exit(); }});
}, 1000);

// Init time (this will be used as a timeout before trying to buy again, when not enough budget)
let buyTimeout = {}; productIds.forEach(product => buyTimeout[product] = 0);
setInterval(_ => {
  Object.keys(buyTimeout).forEach(product => {if (buyTimeout[product] > 0) { buyTimeout[product]--; }});
}, 1000);

// Inits the trade by listening to the websocket values
let isBuying  = {};
let isSelling = {};
productIds.forEach(product => { isBuying[product] = false; isSelling[product] = false; })

// Listen to the WebSocket messages
client.ws.on(WebSocketEvent.ON_MESSAGE, message => {
  // Set the actual product
  const productId = message.product_id;

  // Reset the timer
  if (message.type === WebSocketChannelName.HEARTBEAT) { heartBeats[productId] = 0; return; }

  // Don't do anything if it's on a buy timeout
  if (message.type !== WebSocketChannelName.TICKER || buyTimeout[productId] > 0) return;

  // Actual Rate
  const buyRate   = Helpers.addPercent(message.best_ask, percentFee);
  const sellRate  = Helpers.subPercent(message.best_bid, percentFee);

  if (!isSelling[productId]) {
    isSelling[productId] = true;

    // Sell at the right moment
    sellWhenHigh(productId, sellRate, buyRate);
  }

  if (!isBuying[productId]) {
    isBuying[productId] = true;

    // Buy when the value is too low compared to the last sale
    buyWhenTooLow(productId, sellRate, buyRate);

    // Buy when there is no buy orders active
    buyWhenNoActiveOrders(productId, sellRate, buyRate);
  }
});

/**
 * Wait for the best moment to sell
 * If the new value is X% (+ com) higher than the lowest bought value, wait and then buy
 * @param productId
 * @param sellRate
 * @param buyRate
 */
function sellWhenHigh(productId, sellRate, buyRate) {
  DB.crypto[productId].find({
    selector: {is_active: {'$eq': true}},
    sort: [{price: 'asc'}],
    limit: 1
  }, (err, response) => sellTrade(response, productId, sellRate, buyRate));
}

/**
 * If the value decrease too much we buy again
 * @param productId
 * @param sellRate
 * @param buyRate
 */
function buyWhenTooLow(productId, sellRate, buyRate) {
  DB.crypto[productId].find({
    selector: {is_active: {'$eq': true}},
    sort: [{price: 'asc'}],
    limit: 1
  }, (err, response) => buyTrade(response, productId, sellRate, buyRate));
}

/**
 * When there is no active orders, we wait for the lowest price and we buy
 * @param productId
 * @param sellRate
 * @param buyRate
 */
function buyWhenNoActiveOrders(productId, sellRate, buyRate) {
  DB.crypto[productId].find({
    selector: {is_active: {'$eq': true}}
  }, (err, response) => {
    // If there is no active documents, look for the latest sell
    if (!response.docs.length) {
      DB.crypto[productId].find({
        selector: {is_active: {'$eq': false}},
        sort: [{updated_at: 'desc'}],
        limit: 1
      }, (err, response) => buyTrade(response, productId, sellRate, buyRate, true));
    }
  });
}

/**
 * Sell Trading code (to avoid duplication)
 * @param response
 * @param productId
 * @param sellRate
 * @param buyRate
 */
function sellTrade(response, productId, sellRate, buyRate) {
  if (response && response.docs.length) {
    let foundDoc = response.docs[0];
    if (Helpers.subPercent(sellRate, percentToSell) >= foundDoc.price) {
      // Store the new value into the db if the percent loss is not higher than the defined
      if (!foundDoc.last_high_price || foundDoc.last_high_price < sellRate) {
        foundDoc.last_high_price = sellRate;
        foundDoc.updated_at = new Date();
        DB.crypto[productId].insert(foundDoc, foundDoc._id).then(_ => isSelling[productId] = false).catch(() => {});
      } else if (Helpers.subPercent(foundDoc.last_high_price, percentSecurity) >= sellRate) {
        // Description notification
        const descriptionNotification =
          '*Product:* ' + productId + '\n' +
          '*Sold for:* ' + sellRate + '\n' +
          '*Highest price:* ' + foundDoc.last_high_price + '\n' +
          '*Original price:* ' + foundDoc.price;

        // Store the log
        console.log('------------------------');
        console.log(new Date());
        console.log(descriptionNotification.replace(/[*]/gm, ''));
        console.log('------------------------');

        // Send a notification
        webHook.send({text: descriptionNotification}).then();

        // Mark it as not active in the DB
        client.rest.order.placeOrder({
          size: foundDoc.size,
          type: 'market',
          side: 'sell',
          product_id: productId
        }).then((order) => {
          // Register the new order in the DB
          checkFillsOrder(productId, order.id).then(filledOrder => {
            // Mark it as not active in the DB
            // Remover the last_low_price to not conflict with a future buy
            delete foundDoc['last_low_price'];
            foundDoc.is_active = false;
            foundDoc.updated_at = new Date();
            foundDoc.sell_price = filledOrder.price;
            DB.crypto[productId].insert(foundDoc, foundDoc._id).then(() => {
              isSelling[productId] = false;
              updateWallet();
            }).catch((err) => console.error(err));
          });
        });
      } else { isSelling[productId] = false; }
    } else { isSelling[productId] = false; }
  } else { isSelling[productId] = false; }
}

/**
 * Buy Trading code (to avoid duplication)
 * @param response
 * @param productId
 * @param sellRate
 * @param buyRate
 * @param isReBuy
 */
function buyTrade(response, productId, sellRate, buyRate, isReBuy = false) {
  if (response && response.docs.length) {
    let foundDoc = response.docs[0];

    // If it's a start buy (no other active orders) we store the sold price, otherwise we store the bought price
    if (!isReBuy && Helpers.subPercent(foundDoc.price, percentToBuy) >= buyRate
      || (isReBuy && Helpers.addPercent(foundDoc.sell_price, percentToReBuy) <= buyRate)) {
      // Store the new value into the db if the percent loss is higher than the defined
      if (!isReBuy && (!foundDoc.last_low_price || foundDoc.last_low_price > buyRate)) {
        foundDoc.last_low_price = buyRate;
        foundDoc.updated_at = new Date();
        DB.crypto[productId].insert(foundDoc, foundDoc._id).then(_ => isBuying[productId] = false).catch(() => {});
      } else if (isReBuy || Helpers.addPercent(foundDoc.last_low_price, percentSecurity) <= buyRate) {
        // If the percentage drops bellow a certain percentage we need to buy another time just to be safe
        if (wallets['EUR'] >= (isReBuy ? tradeValueRe : tradeValue)) {
          // Description notification
          const descriptionNotification =
            '*Product:* ' + productId + '\n' +
            '*Bought for:* ' + buyRate + '\n' +
            '*Lowest price:* ' + foundDoc.last_low_price + '\n' +
            '*Original price:* ' + (isReBuy ? foundDoc.sell_price : foundDoc.price) + '\n' +
            '*Wallet (' + productId + '):* ' + wallets['EUR'] + '\n' +
            '*Trade Value:* ' + (isReBuy ? tradeValueRe : tradeValue) + '\n' +
            '*Is Re Buy:* ' + isReBuy;

          // Store the log
          console.log('------------------------');
          console.log(new Date());
          console.log(descriptionNotification.replace(/[*]/gm, ''));
          console.log('------------------------');

          // Send a notification
          webHook.send({text: descriptionNotification}).then();

          // Place the buy order
          client.rest.order.placeOrder({
            funds: (isReBuy ? tradeValueRe : tradeValue),
            type: 'market',
            side: 'buy',
            product_id: productId
          }).then((order) => {
            // Remover the last_low_price to not conflict with a future buy
            delete foundDoc['last_low_price'];
            foundDoc.updated_at = new Date();
            DB.crypto[productId].insert(foundDoc, foundDoc._id).catch(() => {});

            // Register the new order in the DB
            checkFillsOrder(productId, order.id).then(filledOrder => {
              DB.crypto[productId].insert({
                price: filledOrder.price,
                size: filledOrder.size,
                is_active: true,
                created_at: new Date(),
                updated_at: new Date(),
              }).then(() => {
                // Set the boolean to false and update the wallet
                isBuying[productId] = false;
                updateWallet();
              }).catch((err) => console.error(err));
            });
          });
        } else {
          // Description notification
          const descriptionNotification =
            '*Product:* ' + productId + '\n' +
            '*NOT ENOUGH CREDITS TO BUY*' + '\n' +
            '*Buy Rate:* ' + buyRate;

          // Store the log
          console.log('------------------------');
          console.log(new Date());
          console.log(descriptionNotification.replace(/[*]/gm, ''));
          console.log('------------------------');

          // Send a notification
          webHook.send({text: descriptionNotification}).then();

          // Set a buy timeout of 30 minutes
          buyTimeout[productId] = 1800;

          // Remover the last_low_price to avoid having this repeated multiple time if there is no money in the wallet
          delete foundDoc['last_low_price'];
          foundDoc.updated_at = new Date();
          DB.crypto[productId].insert(foundDoc, foundDoc._id).then(() => {
            // Set the boolean to false and update the wallet
            isBuying[productId] = false;
            updateWallet();
          }).catch(() => {});
        }
      } else { isBuying[productId] = false; }
    } else { isBuying[productId] = false; }
  } else { isBuying[productId] = false; }
}

/**
 * Check for the fills, in order to return the price and size as one single value
 * @param productId
 * @param orderId
 */
function checkFillsOrder(productId, orderId) {
  return new Promise((resolve, reject) => {
    const interval = setInterval(_ => {
      client.rest.fill.getFillsByProductId(productId).then(fills => {
        // Retrieve all the fills from the order
        fills = fills.filter(fill => fill.order_id === orderId);

        // Check if all of them are settled
        if (fills.length && fills.every(fill => fill.settled)) {
          clearInterval(interval);
          resolve({
            price: fills.reduce((num, fill) => num + Number(fill.price), 0) / fills.length,
            size: fills.reduce((num, fill) => num + Number(fill.size), 0)
          });
        }

        // Description notification
        const descriptionNotification =
          '*Product:* ' + productId + '\n' +
          '*OrderID:* ' + orderId + '\n' +
          '*Waiting for the order to be filled*'

        // Store the log
        console.log('------------------------');
        console.log(new Date());
        console.log(descriptionNotification.replace(/[*]/gm, ''));
        console.log('------------------------');

        // Send a notification
        webHook.send({text: descriptionNotification}).then();
      }).catch(_ => reject());
    }, 5000);
  });
}

// Find and handle all the errors through here
process.on('unhandledRejection', (reason, p) => {
  console.error("Unhandled Rejection at: Promise ", p, " reason: ", reason);
  process.exit();
});
