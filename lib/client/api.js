'use strict';

var _ = require('lodash');
var $ = require('preconditions').singleton();
var util = require('util');
var async = require('async');
var log = require('npmlog');
var request = require('request')
log.debug = log.verbose;

var Bitcore = require('bitcore')
var WalletUtils = require('../walletutils');
var Verifier = require('./verifier');
var ServerCompromisedError = require('./servercompromisederror')

var BASE_URL = 'http://localhost:3001/copay/api';

var WALLET_CRITICAL_DATA = ['xPrivKey', 'm', 'publicKeyRing', 'sharedEncryptingKey'];
var WALLET_EXTRA_DATA = ['copayerId', 'roPrivKey', 'rwPrivKey'];

function _encryptMessage(message, encryptingKey) {
  if (!message) return null;
  return WalletUtils.encryptMessage(message, encryptingKey);
};

function _decryptMessage(message, encryptingKey) {
  if (!message) return '';
  try {
    return WalletUtils.decryptMessage(message, encryptingKey);
  } catch (ex) {
    return '<ECANNOTDECRYPT>';
  }
};

function _processTxps(txps, encryptingKey) {
  _.each([].concat(txps), function(txp) {
    txp.encryptedMessage = txp.message;
    txp.message = _decryptMessage(txp.message, encryptingKey);
    _.each(txp.actions, function(action) {
      action.comment = _decryptMessage(action.comment, encryptingKey);
    });
  });
};

function _parseError(body) {
  if (_.isString(body)) {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {
        error: body
      };
    }
  }
  var code = body.code || 'ERROR';
  var message = body.error || 'There was an unknown error processing the request';
  log.error(code, message);
  return {
    message: message,
    code: code
  };
};

function _signRequest(method, url, args, privKey) {
  var message = method.toLowerCase() + '|' + url + '|' + JSON.stringify(args);
  return WalletUtils.signMessage(message, privKey);
};


function API(opts) {
  if (!opts.storage) {
    throw new Error('Must provide storage option');
  }
  this.storage = opts.storage;
  this.verbose = !!opts.verbose;
  this.request = request || opts.request;
  this.baseUrl = opts.baseUrl || BASE_URL;
  this.basePath = this.baseUrl.replace(/http.?:\/\/[a-zA-Z0-9:-]*\//, '/');
  if (this.verbose) {
    log.level = 'debug';
  } else {
    log.level = 'info';
  }
};


API.prototype._tryToComplete = function(data, cb) {
  var self = this;

  var url = '/v1/wallets/';
  self._doGetRequest(url, data, function(err, ret) {
    if (err) return cb(err);
    var wallet = ret.wallet;

    if (wallet.status != 'complete')
      return cb('Wallet Incomplete');

    if (!Verifier.checkCopayers(wallet.copayers, data.walletPrivKey,
      data.xPrivKey, data.n)) {

      return cb(new ServerCompromisedError(
        'Copayers in the wallet could not be verified to have known the wallet secret'));
    }

    data.publicKeyRing = _.pluck(wallet.copayers, 'xPubKey')

    self.storage.save(data, function(err) {
      return cb(err, data);
    });
  });
};



API.prototype._load = function(cb) {
  var self = this;

  this.storage.load(function(err, data) {
    if (err || !data) {
      return cb(err || 'Wallet file not found.');
    }
    return cb(null, data);
  });
};


API.prototype._loadAndCheck = function(cb) {
  var self = this;

  this._load(function(err, data) {
    if (err) return cb(err);
    if (data.n > 1) {
      var pkrComplete = data.publicKeyRing && data.m && data.publicKeyRing.length === data.n;

      if (!pkrComplete) {
        return self._tryToComplete(data, cb);
      }
    }
    return cb(null, data);
  });
};

API.prototype._doRequest = function(method, url, args, data, cb) {
  var reqSignature;
  data = data || {};

  if (method == 'get') {
    if (data.roPrivKey)
      reqSignature = _signRequest(method, url, args, data.roPrivKey);
  } else {
    if (data.rwPrivKey)
      reqSignature = _signRequest(method, url, args, data.rwPrivKey);
  }

  var absUrl = this.baseUrl + url;
  var args = {
    // relUrl: only for testing with `supertest`
    relUrl: this.basePath + url,
    headers: {
      'x-identity': data.copayerId,
      'x-signature': reqSignature,
    },
    method: method,
    url: absUrl,
    body: args,
    json: true,
  };
  log.verbose('Request Args', util.inspect(args, {
    depth: 10
  }));
  this.request(args, function(err, res, body) {
    log.verbose(util.inspect(body, {
      depth: 10
    }));
    if (err) return cb(err);

    if (res.statusCode != 200) {
      return cb(_parseError(body));
    }

    return cb(null, body, res.header);
  });
};


API.prototype._doPostRequest = function(url, args, data, cb) {
  return this._doRequest('post', url, args, data, cb);
};

API.prototype._doGetRequest = function(url, data, cb) {
  return this._doRequest('get', url, {}, data, cb);
};


API.prototype._initData = function(network, walletPrivKey, m, n) {
  var xPrivKey = new Bitcore.HDPrivateKey(network);
  var xPubKey = (new Bitcore.HDPublicKey(xPrivKey)).toString();
  var roPrivKey = xPrivKey.derive('m/1/0').privateKey;
  var rwPrivKey = xPrivKey.derive('m/1/1').privateKey;
  var sharedEncryptingKey = Bitcore.crypto.Hash.sha256(walletPrivKey.toBuffer()).slice(0, 16).toString('base64');
  var copayerId = WalletUtils.xPubToCopayerId(xPubKey);

  var data = {
    copayerId: copayerId,
    xPrivKey: xPrivKey.toString(),
    publicKeyRing: [xPubKey],
    network: network,
    m: m,
    n: n,
    roPrivKey: roPrivKey.toWIF(),
    rwPrivKey: rwPrivKey.toWIF(),
    walletPrivKey: walletPrivKey.toWIF(),
    sharedEncryptingKey: sharedEncryptingKey,
  };
  return data;
};

API.prototype._doJoinWallet = function(walletId, walletPrivKey, xPubKey, copayerName, cb) {
  var args = {
    walletId: walletId,
    name: copayerName,
    xPubKey: xPubKey,
    xPubKeySignature: WalletUtils.signMessage(xPubKey, walletPrivKey),
  };
  var url = '/v1/wallets/' + walletId + '/copayers';
  this._doPostRequest(url, args, {}, function(err, body) {
    if (err) return cb(err);
    return cb(null, body.wallet);
  });
};


API.prototype.createWallet = function(walletName, copayerName, m, n, network, cb) {
  var self = this;
  network = network || 'livenet';
  if (!_.contains(['testnet', 'livenet'], network))
    return cb('Invalid network');

  this.storage.load(function(err, data) {
    if (data)
      return cb(self.storage.getName() + ' already contains a wallet');

    var walletPrivKey = new Bitcore.PrivateKey();
    var args = {
      name: walletName,
      m: m,
      n: n,
      pubKey: walletPrivKey.toPublicKey().toString(),
      network: network,
    };
    var url = '/v1/wallets/';
    self._doPostRequest(url, args, {}, function(err, body) {
      if (err) return cb(err);

      var walletId = body.walletId;

      var secret = WalletUtils.toSecret(walletId, walletPrivKey, network);
      var data = self._initData(network, walletPrivKey, m, n);
      self._doJoinWallet(walletId, walletPrivKey, data.publicKeyRing[0], copayerName,
        function(err, wallet) {
          if (err) return cb(err);
          self.storage.save(data, function(err) {
            return cb(err, n > 1 ? secret : null);
          });
        });
    });
  });
};


API.prototype.reCreateWallet = function(walletName, cb) {
  var self = this;
  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);

    var walletPrivKey = new Bitcore.PrivateKey();
    var args = {
      name: walletName,
      m: data.m,
      n: data.n,
      pubKey: walletPrivKey.toPublicKey().toString(),
      network: data.network,
    };
    var url = '/v1/wallets/';
    self._doPostRequest(url, args, {}, function(err, body) {
      if (err) return cb(err);

      var walletId = body.walletId;

      var secret = WalletUtils.toSecret(walletId, walletPrivKey, data.network);
      var i = 0;
      async.each(data.publicKeyRing, function(xpub, next) {
        var copayerName = 'recovered Copayer #' + i;
        self._doJoinWallet(walletId, walletPrivKey, data.publicKeyRing[i++], copayerName, next);
      }, function(err) {
        return cb(err);
      });
    });
  });
};


API.prototype.joinWallet = function(secret, copayerName, cb) {
  var self = this;

  this.storage.load(function(err, data) {
    if (data)
      return cb('Storage already contains a wallet');

    try {
      var secretData = WalletUtils.fromSecret(secret);
    } catch (ex) {
      return cb(ex);
    }
    var data = self._initData(secretData.network, secretData.walletPrivKey);
    self._doJoinWallet(secretData.walletId, secretData.walletPrivKey, data.publicKeyRing[0], copayerName,
      function(err, wallet) {
        if (err) return cb(err);
        data.m = wallet.m;
        data.n = wallet.n;
        self.storage.save(data, cb);
      });
  });
};

API.prototype.getStatus = function(cb) {
  var self = this;

  this._load(function(err, data) {
    if (err) return cb(err);

    var url = '/v1/wallets/';
    self._doGetRequest(url, data, function(err, result) {
      _processTxps(result.pendingTxps, data.sharedEncryptingKey);
      return cb(err, result, data.copayerId);
    });
  });
};

/**
 * send
 *
 * @param opts
 * @param opts.toAddress
 * @param opts.amount
 * @param opts.message
 */
API.prototype.sendTxProposal = function(opts, cb) {
  $.checkArgument(opts);
  $.shouldBeNumber(opts.amount);

  var self = this;

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);

    if (!data.rwPrivKey)
      return cb('No key to generate proposals');

    var args = {
      toAddress: opts.toAddress,
      amount: opts.amount,
      message: _encryptMessage(opts.message, data.sharedEncryptingKey),
    };
    var hash = WalletUtils.getProposalHash(args.toAddress, args.amount, args.message);
    args.proposalSignature = WalletUtils.signMessage(hash, data.rwPrivKey);
    log.debug('Generating & signing tx proposal hash -> Hash: ', hash, ' Signature: ', args.proposalSignature);

    var url = '/v1/txproposals/';
    self._doPostRequest(url, args, data, cb);
  });
};

API.prototype.createAddress = function(cb) {
  var self = this;

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);

    var url = '/v1/addresses/';
    self._doPostRequest(url, {}, data, function(err, address) {
      if (err) return cb(err);
      if (!Verifier.checkAddress(data, address)) {
        return cb(new ServerCompromisedError('Server sent fake address'));
      }

      return cb(null, address);
    });
  });
};

/*
 * opts.doNotVerify
 */

API.prototype.getMainAddresses = function(opts, cb) {
  var self = this;

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);

    var url = '/v1/addresses/';
    self._doGetRequest(url, data, function(err, addresses) {
      if (err) return cb(err);

      if (!opts.doNotVerify) {
        var fake = _.any(addresses, function(address) {
          return !Verifier.checkAddress(data, address);
        });
        if (fake)
          return cb(new ServerCompromisedError('Server sent fake address'));
      }
      return cb(null, addresses);
    });
  });
};

API.prototype.history = function(limit, cb) {

};

API.prototype.getBalance = function(cb) {
  var self = this;

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);
    var url = '/v1/balance/';
    self._doGetRequest(url, data, cb);
  });
};

/**
 * export
 *
 * @param opts.access =['full', 'readonly', 'readwrite']
 */
API.prototype.export = function(opts, cb) {
  var self = this;
  $.shouldBeFunction(cb);
  opts = opts || {};
  var access = opts.access || 'full';

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);
    var v = [];

    var myXPubKey = (new Bitcore.HDPublicKey(data.xPrivKey)).toString();

    _.each(WALLET_CRITICAL_DATA, function(k) {
      var d;

      if (access != 'full' && k === 'xPrivKey') {
        v.push(null);
        return;
      }

      // Skips own pub key IF priv key is exported
      if (access == 'full' && k === 'publicKeyRing') {
        d = _.without(data[k], myXPubKey);
      } else {
        d = data[k];
      }
      v.push(d);
    });

    if (access != 'full') {
      v.push(data.copayerId);
      v.push(data.roPrivKey);
      if (access == 'readwrite') {
        v.push(data.rwPrivKey);
      }
    }

    return cb(null, JSON.stringify(v));
  });
}


API.prototype.import = function(str, cb) {
  var self = this;

  this.storage.load(function(err, data) {
    if (data)
      return cb('Storage already contains a wallet');

    data = {};

    var inData = JSON.parse(str);
    var i = 0;

    _.each(WALLET_CRITICAL_DATA.concat(WALLET_EXTRA_DATA), function(k) {
      data[k] = inData[i++];
    });

    if (data.xPrivKey) {
      var xpriv = new Bitcore.HDPrivateKey(data.xPrivKey);
      var xPubKey = new Bitcore.HDPublicKey(xpriv).toString();
      data.publicKeyRing.unshift(xPubKey);
      data.copayerId = WalletUtils.xPubToCopayerId(xPubKey);
      data.roPrivKey = xpriv.derive('m/1/0').privateKey.toWIF();
      data.rwPrivKey = xpriv.derive('m/1/1').privateKey.toWIF();
    }

    data.n = data.publicKeyRing.length;

    if (!data.copayerId || !data.n || !data.m)
      return cb('Invalid source data');

    data.network = data.publicKeyRing[0].substr(0, 4) == 'tpub' ? 'testnet' : 'livenet';
    self.storage.save(data, function(err) {
      return cb(err, WalletUtils.accessFromData(data));
    });
  });
};

/**
 *
 */

API.prototype.parseTxProposals = function(txps, cb) {
  var self = this;

  this._load(function(err, data) {
    if (err) return cb(err);
    if (data.n > 1) {
      var pkrComplete = data.publicKeyRing && data.m && data.publicKeyRing.length === data.n;
      if (!pkrComplete) {
        return cb('Wallet Incomplete');
      }
    }


    _processTxps(txps, data.sharedEncryptingKey);

    var fake = _.any(txps, function(txp) {
      return (!Verifier.checkTxProposal(data, txp));
    });

    if (fake)
      return cb(new ServerCompromisedError('Server sent fake transaction proposal'));

    return cb(null, txps);
  });
};



/**
 *
 * opts.doNotVerify
 * opts.getRawTxps
 * @return {undefined}
 */

API.prototype.getTxProposals = function(opts, cb) {
  var self = this;

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);
    var url = '/v1/txproposals/';
    self._doGetRequest(url, data, function(err, txps) {
      if (err) return cb(err);

      var rawTxps;
      if (opts.getRawTxps)
        rawTxps = JSON.parse(JSON.stringify(txps));

      _processTxps(txps, data.sharedEncryptingKey);

      var fake = _.any(txps, function(txp) {
        return (!opts.doNotVerify && !Verifier.checkTxProposal(data, txp));
      });

      if (fake)
        return cb(new ServerCompromisedError('Server sent fake transaction proposal'));

      return cb(null, txps, rawTxps);
    });
  });
};

API.prototype.signTxProposal = function(txp, cb) {
  $.checkArgument(txp.creatorId);

  var self = this;

  this._loadAndCheck(function(err, data) {
    if (err) return cb(err);

    if (!Verifier.checkTxProposal(data, txp)) {
      return cb(new ServerCompromisedError('Server sent fake transaction proposal'));
    }

    //Derive proper key to sign, for each input
    var privs = [],
      derived = {};

    var network = new Bitcore.Address(txp.toAddress).network.name;
    var xpriv = new Bitcore.HDPrivateKey(data.xPrivKey, network);

    _.each(txp.inputs, function(i) {
      if (!derived[i.path]) {
        derived[i.path] = xpriv.derive(i.path).privateKey;
        privs.push(derived[i.path]);
      }
    });

    var t = new Bitcore.Transaction();

    _.each(txp.inputs, function(i) {
      t.from(i, i.publicKeys, txp.requiredSignatures);
    });

    t.to(txp.toAddress, txp.amount)
      .change(txp.changeAddress.address);

    var signatures = _.map(privs, function(priv, i) {
      return t.getSignatures(priv);
    });

    signatures = _.map(_.sortBy(_.flatten(signatures), 'inputIndex'), function(s) {
      return s.signature.toDER().toString('hex');
    });

    var url = '/v1/txproposals/' + txp.id + '/signatures/';
    var args = {
      signatures: signatures
    };

    self._doPostRequest(url, args, data, cb);
  });
};

API.prototype.rejectTxProposal = function(txp, reason, cb) {
  $.checkArgument(cb);

  var self = this;

  this._loadAndCheck(
    function(err, data) {
      if (err) return cb(err);

      var url = '/v1/txproposals/' + txp.id + '/rejections/';
      var args = {
        reason: _encryptMessage(reason, data.sharedEncryptingKey) || '',
      };
      self._doPostRequest(url, args, data, cb);
    });
};

API.prototype.broadcastTxProposal = function(txp, cb) {
  var self = this;

  this._loadAndCheck(
    function(err, data) {
      if (err) return cb(err);

      var url = '/v1/txproposals/' + txp.id + '/broadcast/';
      self._doPostRequest(url, {}, data, cb);
    });
};



API.prototype.removeTxProposal = function(txp, cb) {
  var self = this;
  this._loadAndCheck(
    function(err, data) {
      if (err) return cb(err);
      var url = '/v1/txproposals/' + txp.id;
      self._doRequest('delete', url, {}, data, cb);
    });
};

module.exports = API;