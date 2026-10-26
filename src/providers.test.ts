import {it,expect} from 'vitest';
import {Providers} from './providers.js';
it('rejects environments without configured providers without invoking caller work',async()=>{let invoked=false;await expect(new Providers({},{}).run('unconfigured',async()=>{invoked=true;})).rejects.toThrow('ProvidersUnavailable');expect(invoked).toBe(false);});
