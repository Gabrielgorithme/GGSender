import * as Sentry from '@sentry/react';
import process from 'process';
import pkg from '../package.json';
import ggBuild from './gg-build.json';

const env = process.env;
// GGSender: no crash reports to Sienci from a modified build
if (env.NODE_ENV === 'production' && ggBuild.crashReporting) {
    Sentry.init({
        dsn: 'https://eeb4899f0415aa6bc9de477a7faeb720@o558751.ingest.us.sentry.io/4509479105986560',
        sendDefaultPii: true,
        release: pkg.version,
    });
}
