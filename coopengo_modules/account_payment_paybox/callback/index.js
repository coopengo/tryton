const _ = require('lodash');
const fs = require('fs');
const co = require('co');
const koa = require('koa');
const crypto = require('crypto');
const debug = require('debug');
const Session = require('tryton-session');
const model = require('tryton-model');
const qs = require('querystring');
const config = require('./config');

function PayboxError(message) {
  Error.captureStackTrace(this, this.constructor);
  this.name = this.constructor.name;
  this.message = message;
}

function* verify() {
  if (fs.existsSync(config.PUBKEY_PATH) === false) {
    throw new PayboxError('public key: no such file');
  }
  debug('verifying signature');
  const pubkey = fs.readFileSync(config.PUBKEY_PATH, 'utf-8');
  const verifier = crypto.createVerify(config.HASH);
  var buffer = _.join(_.map(_.omit(this.query, 'signature'), (value, key) => {
    return `${key}=${value}`
  }), '&');
  var signature = _.get(this.query, 'signature');
  buffer = qs.unescape(buffer);
  signature = Buffer.from(qs.unescape(signature), 'base64');
  verifier.update(buffer);
  if (verifier.verify(pubkey, signature) === false) {
    throw new PayboxError('invalid signature');
  }
}

function* login() {
  debug('login');
  this.tryton = new Session(config.COOG_URL, config.COOG_DB);
  yield this.tryton.start(config.COOG_USER, {
    password: config.COOG_PASS
  });
}

function* logout() {
  debug('logout');
  var tryton = this.tryton;
  delete this.tryton;
  yield tryton.stop();
  this.response.status = 200;
}

function* paybox() {
  const query = this.request.query;
  const code = _.get(query, 'code');
  const number = _.get(query, 'number');
  const payments = yield model.Group.search(this.tryton,
    'account.payment.group', {
      domain: ['number', '=', number],
    });
  if (payments.size() !== 1) {
    throw new PayboxError('invalid search');
  }
  const record = _.first(payments.records);
  if (_.isEqual(code, '00000')) {
    debug('payment success');
    const method = 'model.account.payment.group.succeed_payment_group'
    yield this.tryton.rpc(method, [
      [record.id]
    ]);
  }
  else {
    debug('payment fail');
    const method = 'model.account.payment.group.reject_payment_group'
    yield this.tryton.rpc(method, [
      [record.id], code
    ]);
  }
}

function* main() {
  yield verify.apply(this);
  yield login.apply(this);
  yield paybox.apply(this);
  yield logout.apply(this);
}

co(function* () {
    model.init(Session);
    var app = new koa();
    app.on('error', function (err) {
      console.error(err.name + ': ' + err.message);
      console.log(err);
    });
    app.use(function* (next) {
      console.log('received request from: ' + this.origin);
      console.log(this.query);
      try {
        yield next;
      }
      catch (err) {
        this.app.emit('error', err, this);
      }
    });
    app.use(main);
    app.listen(config.PORT);
    return 'Listening on port ' + config.PORT + ' ...'
})
.then(console.log, console.error);
