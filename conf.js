/*jslint node: true */
"use strict";

exports.hub = process.env.testnet ? 'obyte.org/bb-test' : 'obyte.org/bb';
exports.deviceName = 'BTC Oracle';
exports.permanent_paring_secret = '*';

exports.bSingleAddress = true;
exports.bWantNewPeers = false;
exports.MIN_CONFIRMATIONS = 2;
exports.MIN_AVAILABLE_POSTINGS = 100;
