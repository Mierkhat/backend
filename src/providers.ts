import { latestLedger,rpc,MierkhatError } from '@mierkhat/sdk';
// Fixed configured providers only. A half-open probe prevents stampedes after cooldown.
export class Providers {
 private failures=new Map<string,{count:number;until:number;probing:boolean}>();
 constructor(private endpoints:Record<string,string[]>,private networks:Record<string,string>){ }
 async run<T>(environment:string,work:(server:rpc.Server)=>Promise<T>):Promise<T>{
  for(const url of this.endpoints[environment]??[]){
   const state=this.failures.get(url)??{count:0,until:0,probing:false};
   if(state.until>Date.now()||state.probing)continue;
   if(state.count>=5)state.probing=true;
   this.failures.set(url,state);
   try{const server=new rpc.Server(url,{allowHttp:environment==='local' && /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url),timeout:10000});
    const network=await server.getNetwork();if(network.passphrase!==this.networks[environment])throw Error('Provider network mismatch');
    const ledger=await latestLedger(server);if(BigInt(ledger.timestamp)<BigInt(Math.floor(Date.now()/1000)-60))throw Error('Provider ledger stale');
    const result=await work(server);this.failures.delete(url);return result;
   }catch(error){if(error instanceof MierkhatError)throw error;state.count++;state.probing=false;if(state.count>=5)state.until=Date.now()+30000;}
  }
  throw Error('ProvidersUnavailable');
 }
}
