import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {z} from 'zod';
import {MierkhatError,accountSchema,assert,decodeReceipt,environmentSchema,hashSchema,inspectSigned,intentSchema,intentHash,latestLedger,loadDeployment,prepareExit,validateBundle,verifyReview,type DeploymentBundle,type ExitDraft} from '@mierkhat/sdk';
import { Conflict,type Store } from './store.js';
import type {Providers} from './providers.js';
const domain=z.object({environment:environmentSchema,epoch:z.string().min(1).max(80)}).strict();
const prepareBody=domain.extend({revision:z.number().int().positive(),intent:intentSchema}).strict();
const submitBody=domain.extend({signedXdr:z.string().min(1).max(349528),claimedHash:hashSchema,reviewId:z.uuid().nullable()}).strict();
const query=z.object({environment:environmentSchema}).strict();
export async function createApp(options:{store:Store;providers:Providers;bundles:DeploymentBundle[];origins:string[]}) {
 const {store,providers}=options;const bundles=options.bundles.filter(b=>b.enabled).map(validateBundle);
 const app=Fastify({bodyLimit:262144,logger:false,requestTimeout:15000,trustProxy:false});
 await app.register(cors,{origin:options.origins,methods:['GET','POST'],allowedHeaders:['Content-Type','Idempotency-Key']});
 await app.register(rateLimit,{max:60,timeWindow:'1 minute'});
 app.addHook('onSend',async(_req,reply)=>{reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff').header('X-Robots-Tag','noindex, nofollow');});
 app.setErrorHandler((error,req,reply)=>{
  const status=error instanceof Conflict?409:error instanceof z.ZodError?400:error instanceof MierkhatError?422:(typeof error==='object' && error!==null && 'statusCode' in error && error.statusCode===429)?429:503;
  reply.code(status).send({code:error instanceof MierkhatError?error.code:status===409?'Conflict':status===400?'InvalidRequest':status===429?'RateLimited':'Unavailable',copyKey:error instanceof MierkhatError?error.copyKey:status===400?'input.invalid':'service.unavailable',retryable:status>=500||status===429,requestId:req.id});
 });
 const bundle=(environment:string,epoch?:string)=>{const b=bundles.find(v=>v.environment===environment&&(!epoch||v.epoch===epoch));if(!b)throw new MierkhatError('UnsupportedDeployment','route.unsupported');return b;};
 app.get('/v1/openapi.json',async()=>({openapi:'3.1.0',info:{title:'Mierkhat API',version:'0.1.0'},paths:{
  '/v1/exit/prepare':{post:{requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(prepareBody)}}},responses:{'200':{description:'Unsigned candidate requiring independent SDK verification'}}}},
  '/v1/exit/submit':{post:{parameters:[{in:'header',name:'Idempotency-Key',required:true,schema:{type:'string',minLength:16,maxLength:200}}],requestBody:{required:true,content:{'application/json':{schema:z.toJSONSchema(submitBody)}}},responses:{'202':{description:'Recorded for tracking, not a ledger result'}}}},
  '/v1/environments':{get:{responses:{'200':{description:'Enabled pinned deployments'}}}},
  '/v1/profiles/{profileHash}':{get:{parameters:[{in:'path',name:'profileHash',required:true,schema:z.toJSONSchema(hashSchema)},{in:'query',name:'environment',required:true,schema:z.toJSONSchema(environmentSchema)}],responses:{'200':{description:'Immutable public deployment metadata'},'404':{description:'No supported profile'}}}},
  '/v1/reviews/{reviewId}':{get:{parameters:[{in:'path',name:'reviewId',required:true,schema:{type:'string',format:'uuid'}},{in:'query',name:'environment',required:true,schema:z.toJSONSchema(environmentSchema)}],responses:{'200':{description:'Unsigned candidate'},'404':{description:'Unknown or wrong environment'},'410':{description:'Expired review'}}}},
  '/v1/transactions/{hash}':{get:{parameters:[{in:'path',name:'hash',required:true,schema:z.toJSONSchema(hashSchema)},{in:'query',name:'environment',required:true,schema:z.toJSONSchema(environmentSchema)}],responses:{'200':{description:'Hash observation with verified receipt when available'}}}},
  '/v1/health':{get:{responses:{'200':{description:'Ready'},'503':{description:'Database unavailable'}}}}
 }}));
 app.get('/v1/health',async(_req,reply)=>{try{await store.pool.query('SELECT 1');return {status:'ready',enabledDeployments:bundles.length};}catch{return reply.code(503).send({status:'unavailable'});}});
 app.get('/v1/environments',async()=>bundles);
 app.get('/v1/profiles/:profileHash',async(req,reply)=>{const q=query.parse(req.query);const p=z.object({profileHash:hashSchema}).parse(req.params);const found=bundles.find(b=>b.environment===q.environment&&b.profileHash===p.profileHash);if(!found)return reply.code(404).send({code:'NotFound',copyKey:'route.unsupported'});return found;});
 app.post('/v1/exit/prepare',{config:{rateLimit:{max:15,timeWindow:'1 minute'}}},async req=>{
  const body=prepareBody.parse(req.body),b=bundle(body.environment,body.epoch);
  const draft:ExitDraft={intent:body.intent,revision:body.revision,environment:body.environment,epoch:body.epoch};
  const review=await providers.run(body.environment,server=>prepareExit(draft,b,server));return store.saveReview(review);
 });
 app.get('/v1/reviews/:reviewId',async(req,reply)=>{
  const q=query.parse(req.query);const p=z.object({reviewId:z.uuid()}).parse(req.params);const found=await store.getReview(p.reviewId,q.environment);
  if(!found)return reply.code(404).send({code:'ReviewMissing',copyKey:'review.missing'});
  if(found.expired)return reply.code(410).send({code:'ReviewExpired',copyKey:'review.expired'});return found.review;
 });
 app.post('/v1/exit/submit',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
  const body=submitBody.parse(req.body),b=bundle(body.environment,body.epoch);
  const idempotencyKey=z.string().min(16).max(200).parse(req.headers['idempotency-key']);
  const a=inspectSigned(body.signedXdr,b,body.reviewId);assert(a.txHash===body.claimedHash,'HashMismatch');
  if(body.reviewId){const found=await store.getReview(body.reviewId,body.environment);assert(found&&found.review.intentHash===a.review.intentHash&&found.review.envelopeDigest===a.review.envelopeDigest,'ReviewMismatch');a.review=found.review;}
  // Record is committed BEFORE any submit. Workers recover a process death at this boundary.
  await store.record(a,idempotencyKey);
  return reply.code(202).send({hash:a.txHash,state:'recorded',statusUrl:`/v1/transactions/${a.txHash}?environment=${body.environment}`});
 });
 app.get('/v1/transactions/:hash',async(req,reply)=>{
  const q=query.parse(req.query);const p=z.object({hash:hashSchema}).parse(req.params);const row=await store.getAttempt(q.environment,p.hash);
  if(row?.state==='succeeded'||row?.state==='failed')return row.observation;
  const b=bundle(q.environment,row?.epoch);const observation=await providers.run(q.environment,server=>decodeReceipt(server,b,p.hash));
  if(row)await store.update(row,observation);
  return observation;
 });
 return app;
}
