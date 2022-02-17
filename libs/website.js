var fs = require('fs');
var path = require('path');

var async = require('async');
var watch = require('node-watch');
var redis = require('redis');

var dot = require('dot');
var express = require('express');
var bodyParser = require('body-parser');
var compress = require('compression');
var ampCors = require('amp-toolbox-cors');

var Stratum = require('cryptocurrency-stratum-pool');
var util = require('cryptocurrency-stratum-pool/lib/util.js');

var api = require('./api.js');

module.exports = function(logger) {
	dot.templateSettings.strip = false;

	var portalConfig = JSON.parse( process.env.portalConfig );
	var poolConfigs = JSON.parse( process.env.pools );

	var websiteConfig = portalConfig.website;

	var portalApi = new api( logger, portalConfig, poolConfigs );
	var portalStats = portalApi.stats;

	var logSystem = 'Website';

	var pageFiles = {
		'index.html': 'index',
		'home.html': ''
	};

	var pageTemplates = {};

	var pageProcessed = {};
	var indexesProcessed = {};

	var keyScriptTemplate = '';
	var keyScriptProcessed = '';

	var processTemplates = function() {
		for ( var pageName in pageTemplates ) {
			if (pageName === 'index') {
				continue;
			}

			pageProcessed[pageName] = pageTemplates[pageName]( {
				canonical: '/' + ( pageName === '' ? '' : pageName + '.html' ),
				poolsConfigs: poolConfigs,
				stats: portalStats.stats,
				portalConfig: portalConfig
			} );
			indexesProcessed[pageName] = pageTemplates.index( {
				page: pageProcessed[pageName],
				selected: pageName,
				stats: portalStats.stats,
				poolConfigs: poolConfigs,
				portalConfig: portalConfig
			} );
		}
	};

	var readPageFiles = function(files) {
		async.each( files, function(fileName, callback) {
			var filePath = 'website/' + ( fileName === 'index.html' ? '' : 'pages/' ) + fileName;
			fs.readFile( filePath, 'utf8', function(err, data) {
				var pTemp = dot.template( data );
				pageTemplates[pageFiles[fileName]] = pTemp
				callback();
			} );
		}, function(err) {
			if (err) {
				console.log( 'error reading files for creating dot templates: '+ JSON.stringify( err ) );
				return;
			}
			processTemplates();
		} );
	};

	// if an html file was changed reload it
	/* requires node-watch 0.5.0 or newer */
	watch( ['./website', './website/pages'], function(evt, filename) {
		var basename;
		// support older versions of node-watch automatically
		if ( !filename && evt ) {
			basename = path.basename( evt );
		} else {
			basename = path.basename( filename );
		}

		if ( basename in pageFiles ) {
			readPageFiles( [ basename ] );
			logger.special( logSystem, 'Server', 'Reloaded file ' + basename );
		}
	} );

	portalStats.getGlobalStats( function() {
		readPageFiles( Object.keys( pageFiles ) );
	} );

	var buildUpdatedWebsite = function() {
		portalStats.getGlobalStats( function() {
			processTemplates();

			var statData = 'data: ' + JSON.stringify( portalStats.stats ) + '\n\n';
			for ( var uid in portalApi.liveStatConnections ) {
				var res = portalApi.liveStatConnections[uid];
				res.write(statData);
			}
		} );
	};

	setInterval( buildUpdatedWebsite, websiteConfig.stats.updateInterval * 1000 );

	var getPage = function(pageId) {
		if ( pageId in pageProcessed ) {
			var requestedPage = pageProcessed[pageId];
			return requestedPage;
		}
	};

	var minerpage = function(req, res, next) {
		var address = req.params.address || null;
		if (address != null) {
			address = address.split(".")[0];
			portalStats.getBalanceByAddress(address, function() {
				processTemplates();
				res.header('Content-Type', 'text/html');
				res.end(indexesProcessed['miner-statistics']);
			});
		} else {
			next();
		}
	};

	var payout = function(req, res, next) {
		var address = req.params.address || null;
		if (address != null) {
			portalStats.getPayout(address, function(data) {
				res.write(data.toString());
				res.end();
			});
		} else {
			next();
		}
	};

	var shares = function(req, res, next) {
		portalStats.getCoins(function() {
			processTemplates();
			res.end(indexesProcessed['user_shares']);
		});
	};

	var usershares = function(req, res, next) {
		var coin = req.params.coin || null;
		if (coin != null) {
			portalStats.getCoinTotals(coin, null, function() {
				processTemplates();
				res.end(indexesProcessed['user_shares']);
			});
		} else {
			next();
		}
	};

	var route = function(req, res, next) {
		var pageId = req.params.page || '';
		if ( pageId in indexesProcessed ) {
			res.header( 'Content-Type', 'text/html' );
			res.end( indexesProcessed[pageId] );
		} else {
			next();
		}
	};

	var app = express();
	app.use(ampCors());
	app.use(bodyParser.json());

	app.get( '/donate/:coin/:address', function(req, res, next) {
		if ( req.params.coin && req.params.address ) {
			var protocol = null;
			protocol = 'litecoin';
			if ( protocol != null ) {
				res.header( 'X-Robots-Tag', 'none' );
				res.redirect( 301, protocol + ':' + req.params.address );
				return;
			}
		}
		next();
	} );
	app.get( '/get-page', function(req, res, next) {
		var requestedPage = getPage( req.query.id );
		if ( requestedPage ) {
			res.end( requestedPage );
			return;
		}
		next();
	} );

	app.get( '/workers/:address', minerpage );

	app.get( '/:page', route );
	app.get( '/', route );

	app.get( '/api/:method', function(req, res, next) {
		portalApi.handleApiRequest( req, res, next );
	} );

	app.post('/api/admin/:method', function(req, res, next){
		if (portalConfig.website &&
			portalConfig.website.adminCenter &&
			portalConfig.website.adminCenter.enabled
		) {
			if ( portalConfig.website.adminCenter.password === req.body.password ) {
				portalApi.handleAdminApiRequest( req, res, next );
			} else {
				res.send( 401, JSON.stringify( {
					error: 'Incorrect Password'
				} ) );
			}
		} else {
			next();
		}
	} );

	express.static.mime.define( {
		'text/plain': ['pub']
	} );
	app.use( compress() );
	app.use( '/dist', express.static( 'website/dist' ) );

	app.use( function(err, req, res, next) {
		console.error( err.stack );
		res.send( 500, 'Something broke!' );
	} );

	try {
		app.listen( portalConfig.website.port, portalConfig.website.host, function () {
			logger.debug( logSystem, 'Server', 'Website started on ' + portalConfig.website.host + ':' + portalConfig.website.port );
		} );
	} catch(e) {
		logger.error( logSystem, 'Server', 'Could not start website on ' + portalConfig.website.host + ':' + portalConfig.website.port +  ' - its either in use or you do not have permission' );
	}
};
