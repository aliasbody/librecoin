const nano = require('nano')('http://localhost:5984');

// Orders Collection
module.exports = {
  crypto: {
    'BTC-EUR': nano.use('bitcoin'),
    'ETH-EUR': nano.use('ether'),
    'XRP-EUR': nano.use('ripple'),
    'LTC-EUR': nano.use('litecoin'),
    'BCH-EUR': nano.use('bitcoin-cash'),
    'EOS-EUR': nano.use('eos'),
    'XLM-EUR': nano.use('stellar'),
    'ETC-EUR': nano.use('ether-classic'),
    'ZRX-EUR': nano.use('zero-x'),
  },
};
