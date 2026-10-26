import { readFile } from 'node:fs/promises';
import { bundleSchema,validateBundle } from '../src/index.js';
const bundles=JSON.parse(await readFile(new URL('../deployments/index.json',import.meta.url),'utf8'));
if(!Array.isArray(bundles))throw Error('Deployment registry must be an array');
const keys=new Set();for(const value of bundles){const b=bundleSchema.parse(value);const key=b.environment+':'+b.epoch;if(keys.has(key))throw Error('Duplicate deployment epoch');keys.add(key);if(b.enabled)validateBundle(b);}
console.log(`${bundles.length} deployment bundles checked; empty registry disables live signing.`);
