import { configure, getLogger, Logger } from 'log4js';

configure({
  appenders: {
    everything: { type: 'stdout' },
    main: { type: 'file', filename: 'main.log', maxLogSize: 1048576, backups: 3, append: false },
    infofilter: { type: 'logLevelFilter', appender: 'everything', level: 'info' }
  },
  categories: { default: { appenders: ['main', 'infofilter'], level: 'all' } }
});

export const LOG = getLogger('main');

export function mainLog(): Logger {
  return getLogger('main');
}

