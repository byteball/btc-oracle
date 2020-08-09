/*jslint node: true */
'use strict';
var util = require('util');
var crypto = require('crypto');
var async = require('ocore/node_modules/async');
var _ = require('ocore/node_modules/lodash');
var bitcore = require('bitcore-lib');
var EventEmitter = require('events').EventEmitter;
var notifications = require('./notifications.js');
var conf = require('ocore/conf.js');
var objectHash = require('ocore/object_hash.js');
var merkle = require('ocore/merkle.js');
var constants = require('ocore/constants.js');
var db = require('ocore/db.js');
var mutex = require('ocore/mutex.js');
var eventBus = require('ocore/event_bus.js');
var ValidationUtils = require("ocore/validation_utils.js");
var string_utils = require('ocore/string_utils.js');
var desktopApp = require('ocore/desktop_app.js');
var headlessWallet = require('headless-obyte');

const RETRY_TIMEOUT = 300*1000;
const MIN_CONFIRMATIONS = conf.MIN_CONFIRMATIONS || 2;
const BLOCK_HASH_FEED_NAME = 'bitcoin_hash';
const BLOCK_HEIGHT_FEED_NAME = 'bitcoin_height';
const MERKLE_ROOT_FEED_NAME = 'bitcoin_merkle';

var assocQueuedBlocks = {};

var bTestnet = constants.version.match(/t$/);
var my_address;
var bitcoinNetwork = bTestnet ? bitcore.Networks.testnet : bitcore.Networks.livenet;

conf.bSingleAddress = true;
conf.MIN_AVAILABLE_POSTINGS = conf.MIN_AVAILABLE_POSTINGS || 100;

/*
// testnet
headlessWallet.readSingleAddress = function(handleAddress){
	return handleAddress('J4GQZL73OALOHABJVBQHSEMTUAKJ3RQH');
};
*/

// make sure exponential notation is never used
function formatAmount(amount){
	if (amount >= 1)
		return amount;
	return amount.toFixed(8).replace(/0+$/, '');
}


function postDataFeed(datafeed, onDone){
	function onError(err){
		notifications.notifyAdminAboutFailedPosting(err);
		onDone(err);
	}
	var network = require('ocore/network.js');
	var composer = require('ocore/composer.js');
	var arrOutputs = [{amount: 0, address: my_address}];
	let params = {
		paying_addresses: [my_address], 
		outputs: arrOutputs, 
		signer: headlessWallet.signer, 
		callbacks: composer.getSavingCallbacks({
			ifNotEnoughFunds: onError,
			ifError: onError,
			ifOk: function(objJoint){
				network.broadcastJoint(objJoint);
				onDone();
			}
		})
	};
	let objMessage = {
		app: "data_feed",
		payload_location: "inline",
		payload_hash: objectHash.getBase64Hash(datafeed),
		payload: datafeed
	};
	params.messages = [objMessage];
	composer.composeJoint(params);
}

function reliablyPostDataFeed(datafeed){
	assocQueuedBlocks[datafeed[BLOCK_HASH_FEED_NAME]] = true;
	postDataFeed(datafeed, function(err){
		if (err){
			console.log('will retry posting the data feed later');
			setTimeout(function(){
				determineIfDataFeedAlreadyPosted(BLOCK_HASH_FEED_NAME, datafeed[BLOCK_HASH_FEED_NAME], function(bAlreadyPosted){
					if (!bAlreadyPosted)
						reliablyPostDataFeed(datafeed);
				});
			}, RETRY_TIMEOUT + Math.round(Math.random()*3000));
		}
		else
			delete assocQueuedBlocks[datafeed[BLOCK_HASH_FEED_NAME]];
	});
}

function determineIfDataFeedAlreadyPosted(feed_name, value, handleResult){
	const data_feeds = require('ocore/data_feeds.js');
	const storage = require('ocore/storage.js');
	data_feeds.dataFeedExists([my_address], feed_name, '=', value, 0, 1e15, false, function (bExists) {
		if (bExists)
			return handleResult(true);
		var bFound = false;
		for (var unit in storage.assocUnstableMessages) {
			var objUnit = storage.assocUnstableUnits[unit] || storage.assocStableUnits[unit];
			if (!objUnit)
				throw Error("unstable unit " + unit + " not in assoc");
			if (objUnit.author_addresses[0] !== my_address)
				continue;
			storage.assocUnstableMessages[unit].forEach(function (message) {
				if (message.app !== 'data_feed')
					return;
				var payload = message.payload;
				if (!payload.hasOwnProperty(feed_name))
					return;
				var feed_value = payload[feed_name];
				if (value === feed_value)
					bFound = true;
			});
			if (bFound)
				break;
		}
		handleResult(bFound);
	});
}


function readDatafeedValues(address, feed_name, limit, handle) {
	var options = {};
	options.gte = "dfv\n" + address + "\n" + feed_name + '\n';
	options.lte = "dfv\n" + address + "\n" + feed_name + '\n' + "\uFFFF";
	if (limit)
		options.limit = limit;

	var arrValues = [];
	var handleData = function (data){
		var arrParts = data.value.split('\n');
		var value = string_utils.getFeedValue(arrParts[0]); // may convert to number
		arrValues.push(value);
	}
	var kvstore = require('ocore/kvstore.js');
	var stream = kvstore.createReadStream(options);
	stream.on('data', handleData)
	.on('end', function(){
		handle(arrValues);
	})
	.on('error', function(error){
		throw Error('error from data stream: '+error);
	});
}

db.query("INSERT "+db.getIgnore()+" INTO pairing_secrets (pairing_secret, expiry_date, is_permanent) VALUES('0000', '2035-01-01', 1)");

var bHeadlessWalletReady = false;
eventBus.once('headless_wallet_ready', function(){
	if (!conf.admin_email || !conf.from_email){
		console.log("please specify admin_email and from_email in your "+desktopApp.getAppDataDir()+'/conf.json');
		process.exit(1);
	}
	headlessWallet.setupChatEventHandlers();
	headlessWallet.readSingleAddress(function(address){
		my_address = address;
		console.log('===== my address '+my_address);
		bHeadlessWalletReady = true;
	});
});



function initChat(oracleService){
	
	console.log('=== initChat');
	
	// wait and repeat
	if (!bHeadlessWalletReady){
		eventBus.once('headless_wallet_ready', function(){
			bHeadlessWalletReady = true;
			initChat(oracleService);
		});
		return;
	}
	
	var bbWallet = require('ocore/wallet.js');
	var device = require('ocore/device.js');
	
	function readCurrentHeight(handleCurrentHeight){
		oracleService.node.services.bitcoind.getInfo(function(err, currentInfo){
			if (err)
				throw Error("getInfo failed: "+err);
			handleCurrentHeight(currentInfo.blocks);
		});
	}
	
	function checkForMissingBlocks(){
		readDatafeedValues(
			my_address, BLOCK_HEIGHT_FEED_NAME, 100,
			function (arrHeights) {
				arrHeights.sort(); // data feed returns in reverse order by mci
				console.log('last posted block heights', arrHeights);
				if (arrHeights.length === 0) // no blocks yet
					return;
				var arrMissingHeights = [];
				// 1. search for skipped block heights, e.g. 1,2,3,5,6 -- 4 is missing
				var prev_height;
				arrHeights.forEach(height => {
					if (prev_height && height !== prev_height + 1){
						for (var h=prev_height+1; h<height; h++)
							arrMissingHeights.push(h);
					}
					prev_height = height;
				});
				// 2. catch up blocks generated while we were offline
				readCurrentHeight(currentHeight => {
					let last_confirmed_height = currentHeight - MIN_CONFIRMATIONS + 1;
					for (var h=prev_height+1; h<=last_confirmed_height; h++)
						arrMissingHeights.push(h);
					console.log('missing block heights', arrMissingHeights);
					async.eachSeries(arrMissingHeights, postBlockData);
				});
			}
		);
	}
	
	function postBlockData(height, onDone){
		mutex.lock(['post'], unlock => {
			function abort(err){
				console.log(err);
				unlock();
				if (onDone)
					onDone();
			}
			console.log('will post data of block '+height);
			readOutputsInBlock(height, function(arrElements, blockHash){
				if (assocQueuedBlocks[blockHash])
					return abort("block "+blockHash+" already queued");
				determineIfDataFeedAlreadyPosted(BLOCK_HASH_FEED_NAME, blockHash, function(bAlreadyPosted){
					if (bAlreadyPosted)
						return abort("block "+blockHash+" already processed");
					if (assocQueuedBlocks[blockHash])
						return abort("block "+blockHash+" already queued 2");
					let merkle_root = merkle.getMerkleRoot(arrElements);
					let rand_int32 = crypto.createHash("sha256").update(blockHash, "utf8").digest().readUInt32BE(0);
					let rand_1_to_100000 = Math.floor(100000 * rand_int32 / Math.pow(2, 32)) + 1;
					let datafeed = {};
					datafeed[BLOCK_HASH_FEED_NAME] = blockHash;
					datafeed[BLOCK_HEIGHT_FEED_NAME] = height;
					if (merkle_root)
						datafeed[MERKLE_ROOT_FEED_NAME] = merkle_root;
					datafeed['random'+height] = rand_1_to_100000;
					reliablyPostDataFeed(datafeed);
					unlock();
					if (onDone)
						onDone();
				});
			});
		});
	}
	
	function readOutputsInBlock(height, handleOutputElements){
		readBlockWithRetries(height, function(block) {
			var arrElements = [];
			var bAborted = false;
			block.transactions.forEach(transaction => {
				transaction.outputs.forEach(output => {
					if (!output.satoshis)
						return;
					//	throw Error("no satoshis in output "+JSON.stringify(output, null, '\t')+', tx '+JSON.stringify(transaction, null, '\t'));
					let amount = output.satoshis/1e8;
					let address = output.script.toAddress(bitcoinNetwork);
					if (!address){
						return console.log('=== unrecognized output: '+output.inspect());
						/*
						console.error('=== output: '+output.inspect());
						if (output.inspect().match(/OP_RETURN/))
							return console.error('=== skipping OP_RETURN');
						if (output.inspect().match(/OP_0 /))
							return console.error('=== skipping OP_0');
						bAborted = true;
						showTransaction(transaction.hash, () => {
							throw Error("no address in output "+util.inspect(output, {depth:null})+'\ntx '+JSON.stringify(transaction, null, '\t')+'\ninfo '+JSON.stringify(output.script.getAddressInfo(), null, '\t'));
						});
						*/
					}
					let element = address+':'+formatAmount(amount);
					console.log(element);
					arrElements.push(element);
				});
			});
			if (bAborted)
				return;
			arrElements = _.uniq(arrElements);
			arrElements.sort();
			handleOutputElements(arrElements, block.hash);
		});
	}
	
	function readBlockHeaderWithRetries(blockHash, handleBlockHeader, count_tries){
		oracleService.node.services.bitcoind.getBlockHeader(blockHash, function(err, blockHeader) {
			if (err){
				if (count_tries >= 3)
					throw Error('getBlockHeader '+blockHash+' failed after 3 attempts: '+err);
				console.log('getBlockHeader '+blockHash+' attempt '+count_tries+' failed, will retry: '+err);
				setTimeout(() => {
					readBlockHeaderWithRetries(blockHash, handleBlockHeader, (count_tries || 0) + 1);
				}, 30000);
				return;
			}
			console.log('blockHeader '+JSON.stringify(blockHeader, null, '\t'));
			handleBlockHeader(blockHeader);
		});
	}
	
	function readBlockWithRetries(height, handleBlock, count_tries){
		oracleService.node.services.bitcoind.getBlock(height, function(err, block) {
			if (err){
				if (count_tries >= 3)
					throw Error('getBlock '+height+' failed after 3 attempts: '+err);
				console.log('getBlock '+height+' attempt '+count_tries+' failed, will retry: '+err);
				setTimeout(() => {
					readBlockWithRetries(height, handleBlock, (count_tries || 0) + 1);
				}, 30000);
				return;
			}
			handleBlock(block);
		});
	}
	
	/////////////////////////////////
	// start
	
	
	/*
	function showTransaction(txid, onDone){
		console.error('tx '+txid);
		oracleService.node.services.bitcoind.getDetailedTransaction(txid, function(err, info) {
			if (err)
				console.error("getDetailedTransaction "+txid+" failed: "+err);
			console.error('getDetailedTransaction: ', info);
			onDone();
		});
	}*/

	checkForMissingBlocks();
	
	var prev_height;
	oracleService.node.services.bitcoind.on('block', function(blockHash) {
		blockHash = blockHash.toString('hex');
		console.log('=== new block '+blockHash);
		// get only the block header and index (including chain work, height, and previous hash)
		readBlockHeaderWithRetries(blockHash, function(blockHeader) {
			let last_height = blockHeader.height;
			let last_confirmed_height = last_height - MIN_CONFIRMATIONS + 1;
			var arrHeights = [];
			if (prev_height)
				for (var h=prev_height+1; h<=last_confirmed_height; h++)
					arrHeights.push(h); // sometimes 'block' event is not called for a new block, make sure we don't skip it
			else
				arrHeights.push(last_confirmed_height);
			prev_height = last_confirmed_height;
			async.eachSeries(arrHeights, postBlockData);
		//	postBlockData(last_confirmed_height);
		});
	});
	
	eventBus.on('paired', parseText);

	eventBus.on('text', parseText);

	function parseText(from_address, text){
		if (text === conf.permanent_paring_secret || text === '0000'){
			return device.sendMessageToDevice(from_address, 'text', "Type a receiving Bitcoin address, I'll respond with the merkle proof that this address did receive bitcoins.");
		}

		text = text.trim();
		let lc_text = text.toLowerCase();
		
		if (lc_text === 'help')
			return device.sendMessageToDevice(from_address, 'text', "Type a receiving Bitcoin address, I'll respond with the merkle proof that this address did receive bitcoins.");

		var bValidBitcoinAddress = bitcore.Address.isValid(text, bitcoinNetwork);
		if (bValidBitcoinAddress){
			var bitcoin_address = text;
			oracleService.node.services.bitcoind.getAddressHistory([bitcoin_address], {queryMempool: false}, function(err, history){
				if (err){
				//	throw Error('getAddressHistory failed: '+err);
					notifications.notifyAdmin('getAddressHistory '+bitcoin_address+' failed: '+err);
					return device.sendMessageToDevice(from_address, 'text', "Failed to get the address history, try again in a minute.");
				}
				console.log('transactions: '+history.items.length, history);
				history.items = history.items.filter(item => { return (item.satoshis > 0 && item.confirmations >= MIN_CONFIRMATIONS); });
				if (history.items.length === 0)
					return device.sendMessageToDevice(from_address, 'text', "This address didn't receive anything");
				var bFound = false;
				for (var i=0; i<history.items.length; i++){ // history is already sorted in reverse order and truncated at 50 items
					var item = history.items[i];
					/*if (item.satoshis < 0) // spend from the address
						continue;
					if (item.confirmations < MIN_CONFIRMATIONS)
						continue;*/
					var arrAddresses = Object.keys(item.addresses);
					if (arrAddresses.length > 1)
						throw Error('more than 1 to-address: '+arrAddresses.join(', ')+'; tx '+item.tx.hash);
					var to_bitcoin_address = arrAddresses[0];
					if (to_bitcoin_address !== bitcoin_address)
						throw Error('to another address '+to_bitcoin_address+', expected '+bitcoin_address);
					var height = item.tx.height;
					var blockHash = item.tx.blockHash;
					var arrMyElements = [];
					item.tx.outputs.forEach(output => {
						if (output.address !== bitcoin_address)
							return;
						let amount = output.satoshis/1e8;
						let element = bitcoin_address+':'+formatAmount(amount);
						if (arrMyElements.indexOf(element) === -1)
							arrMyElements.push(element);
					});
					if (arrMyElements.length === 0)
						throw Error("my outputs not found in "+JSON.stringify(item.tx));
					console.log(i + ': looking for block ' + height + ': ' + blockHash);
					const data_feeds = require('ocore/data_feeds.js');
					const storage = require('ocore/storage.js');
					data_feeds.readDataFeedValue([my_address], BLOCK_HASH_FEED_NAME, blockHash, 0, 1e15, false, 'last', function (objResult) {
						if (!objResult.value)
							return device.sendMessageToDevice(from_address, 'text', "No proof found for tx " + item.tx.hash + ", block #" + height + " " + blockHash);
						if (!objResult.unit)
							throw Error("no unit");
						storage.readJoint(db, objResult.unit, {
							ifNotFound: function () {
								throw Error("unit " + objResult.unit + " not found");
							},
							ifFound: function (objJoint) {
								const objUnit = objJoint.unit;
								let merkle_root;
								objUnit.messages.forEach(message => {
									if (message.app !== 'data_feed')
										return;
									merkle_root = message.payload[MERKLE_ROOT_FEED_NAME];
									if (!merkle_root)
										throw Error("no merkle root in data feed of " + objResult.unit);
								});
								if (!merkle_root)
									throw Error("no data feed in " + objResult.unit);
								readOutputsInBlock(height, arrElements => {
									arrMyElements.forEach(element => {
										let element_index = arrElements.indexOf(element);
										if (element_index < 0)
											throw Error(element + " not found among block outputs, block " + blockHash);
										let proof = merkle.getMerkleProof(arrElements, element_index);
										let serialized_proof = merkle.serializeMerkleProof(proof);
										if (proof.root !== merkle_root)
											throw Error("merkle root mismatch: in db " + merkle_root + ", proof " + serialized_proof);
										device.sendMessageToDevice(from_address, 'text', "This is your merkle proof of " + element + ".  Please copy and paste it on the Send page to unlock the funds from your smart wallet:\n" + serialized_proof);
									});
								});
							}
						});
					});
					bFound = true;
					break; // handle only the last tx to this address
				}
				if (!bFound)
					throw Error("No incoming transactions to address "+bitcoin_address);
			});
			return;
		}
		else
			return device.sendMessageToDevice(from_address, 'text', "That doesn't look like a valid Bitcoin address.  Type a receiving Bitcoin address, I'll respond with the merkle proof that this address did receive bitcoins.");
		
	}
	
}


function OracleService(options) {
	this.node = options.node;
	EventEmitter.call(this, options);
	this.bus = this.node.openBus();
	
	initChat(this);
}
util.inherits(OracleService, EventEmitter);

OracleService.dependencies = ['bitcoind'];

OracleService.prototype.start = function(callback) {
	setImmediate(callback);
}

OracleService.prototype.stop = function(callback) {
	setImmediate(callback);
}

OracleService.prototype.getAPIMethods = function() {
	return [];
};

OracleService.prototype.getPublishEvents = function() {
	return [];
};

module.exports = OracleService;
