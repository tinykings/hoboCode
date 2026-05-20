import { readConfig, startGateway } from './gateway.ts';

await startGateway(readConfig(process.env));
