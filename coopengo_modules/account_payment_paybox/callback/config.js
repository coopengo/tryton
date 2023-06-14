const _ = require('lodash');
var fromEnv = {};
const PREFIX = 'COOG_PAYBOX_';
fromEnv = _.pickBy(process.env, (v, k) => k.startsWith(PREFIX));
fromEnv = _.mapKeys(fromEnv, (v, k) => k.substring(PREFIX.length));
module.exports = _.assign({
  PORT: 3000,
  COOG_URL: 'http://localhost:8000',
  COOG_DB: '',
  COOG_USER: '',
  COOG_PASS: '',
  HASH: 'RSA-SHA1',
  PUBKEY_PATH: './paybox.pem',
}, fromEnv);
