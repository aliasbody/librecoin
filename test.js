//var yahooFinance = require('yahoo-finance');

// Inits the Coinbase Client
require('dotenv').config({ path: __dirname + '/.env' })
const { CoinbasePro } = require('coinbase-pro-node');

const client = new CoinbasePro({
  apiKey: process.env['COINBASE_API_KEY'],
  apiSecret: process.env['COINBASE_API_SECRET'],
  passphrase: process.env['COINBASE_API_PASSPHRASE'],
  useSandbox: process.env['COINBASE_API_SANDBOX'],
});

client.rest.fill.getFillsByProductId('BTC-EUR').then(fills => {
  console.log(fills.filter(fill => {
    return fill.side === 'sell' && fill.size === '0.00156943'
  }));
});

/*
yahooFinance.historical({
  symbol: 'AAPL',
  from: '2020-04-12',
  to: '2020-04-13',
  // period: 'd'  // 'd' (daily), 'w' (weekly), 'm' (monthly), 'v' (dividends only)
}, function (err, quotes) {
  console.log(err);
  console.log(quotes);
});*/

// This replaces the deprecated snapshot() API
/*let currentQuote = 0;
setInterval(_ => {
  yahooFinance.quote({
    symbol: 'TSLA',
    modules: ['price'] // see the docs for the full list
  }, function (err, quotes) {
    if (currentQuote !== quotes.price.regularMarketPrice) {
      currentQuote = quotes.price.regularMarketPrice;
      console.log(currentQuote);
    }
    //process.exit();
    //console.log(quotes.summaryDetail.bid);
    //console.log(quotes.summaryDetail.ask);
    //console.log('----');
  });
}, 500);
*/
