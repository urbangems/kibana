import _ from 'lodash';
const { isWorker } = require('cluster');
const { resolve } = require('path');

const cwd = process.cwd();
import fromRoot from '../../utils/from_root';

let canCluster;
try {
  require.resolve('../cluster/cluster_manager');
  canCluster = true;
} catch (e) {
  canCluster = false;
}

const pathCollector = function () {
  const paths = [];
  return function (path) {
    paths.push(resolve(process.cwd(), path));
    return paths;
  };
};

const pluginDirCollector = pathCollector();
const pluginPathCollector = pathCollector();

function initServerSettings(opts, extraCliOptions) {
  const readYamlConfig = require('./read_yaml_config');
  const settings = readYamlConfig(opts.config);
  const set = _.partial(_.set, settings);
  const get = _.partial(_.get, settings);
  const has = _.partial(_.has, settings);
  const merge = _.partial(_.merge, settings);

  if (opts.dev) {
    try { merge(readYamlConfig(fromRoot('config/kibana.dev.yml'))); }
    catch (e) { null; }
  }

  if (opts.dev) {
    set('env', 'development');
    set('optimize.lazy', true);
    if (opts.ssl && !has('server.ssl.cert') && !has('server.ssl.key')) {
      set('server.host', 'localhost');
      set('server.ssl.cert', fromRoot('test/dev_certs/server.crt'));
      set('server.ssl.key', fromRoot('test/dev_certs/server.key'));
    }
  }

  if (opts.elasticsearch) set('elasticsearch.url', opts.elasticsearch);
  if (opts.port) set('server.port', opts.port);
  if (opts.host) set('server.host', opts.host);
  if (opts.quiet) set('logging.quiet', true);
  if (opts.silent) set('logging.silent', true);
  if (opts.verbose) set('logging.verbose', true);
  if (opts.logFile) set('logging.dest', opts.logFile);

  set('plugins.scanDirs', _.compact([].concat(
    get('plugins.scanDirs'),
    opts.pluginDir
  )));

  set('plugins.paths', _.compact([].concat(
    get('plugins.paths'),
    opts.pluginPath
  )));

  merge(extraCliOptions);

  return settings;
}

module.exports = function (program) {
  const command = program.command('serve');

  command
  .description('Run the kibana server')
  .collectUnknownOptions()
  .option('-e, --elasticsearch <uri>', 'Elasticsearch instance')
  .option(
    '-c, --config <path>',
    'Path to the config file, can be changed with the CONFIG_PATH environment variable as well',
    process.env.CONFIG_PATH || fromRoot('config/kibana.yml'))
  .option('-p, --port <port>', 'The port to bind to', parseInt)
  .option('-q, --quiet', 'Prevent all logging except errors')
  .option('-Q, --silent', 'Prevent all logging')
  .option('--verbose', 'Turns on verbose logging')
  .option('-H, --host <host>', 'The host to bind to')
  .option('-l, --log-file <path>', 'The file to log to')
  .option(
    '--plugin-dir <path>',
    'A path to scan for plugins, this can be specified multiple ' +
    'times to specify multiple directories',
    pluginDirCollector,
    [
      fromRoot('installedPlugins'),
      fromRoot('src/plugins')
    ]
  )
  .option(
    '--plugin-path <path>',
    'A path to a plugin which should be included by the server, ' +
    'this can be specified multiple times to specify multiple paths',
    pluginPathCollector,
    []
  )
  .option('--plugins <path>', 'an alias for --plugin-dir', pluginDirCollector);

  if (canCluster) {
    command
    .option('--dev', 'Run the server with development mode defaults')
    .option('--no-ssl', 'Don\'t run the dev server using HTTPS')
    .option('--no-base-path', 'Don\'t put a proxy in front of the dev server, which adds a random basePath')
    .option('--no-watch', 'Prevents automatic restarts of the server in --dev mode');
  }

  command
  .action(async function (opts) {
    const settings = initServerSettings(opts, this.getUnknownOptions());

    if (canCluster && opts.dev && !isWorker) {
      // stop processing the action and handoff to cluster manager
      const ClusterManager = require('../cluster/cluster_manager');
      new ClusterManager(opts, settings);
      return;
    }

    let kbnServer = {};
    const KbnServer = require('../../server/kbn_server');
    try {
      kbnServer = new KbnServer(settings);
      await kbnServer.ready();
    }
    catch (err) {
      const { server } = kbnServer;

      if (server) server.log(['fatal'], err);
      console.error('FATAL', err);

      kbnServer.close();
      process.exit(1); // eslint-disable-line no-process-exit
    }

    return kbnServer;
  });
};
