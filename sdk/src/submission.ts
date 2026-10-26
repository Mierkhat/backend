import { Transaction,xdr } from '@stellar/stellar-sdk';
import { decodeEnvelope,verifySigned,authDigest,txV1,verifyEnvelopePolicy } from './policy.js';
import {digest,intentHash,jsonSafe,spec} from './codec.js';
import {intentSchema,type DeploymentBundle,type ExitDraft,type Review,type SignedAttempt} from './model.js';
export function inspectSigned(signedXdr:string,b:DeploymentBundle,reviewId:string|null=null):SignedAttempt {
 const signed=decodeEnvelope(signedXdr,b.networkPassphrase);const op=signed.operations[0];
 if(op?.type!=='invokeHostFunction'||op.func.type!=='hostFunctionTypeInvokeContract'||op.func.invokeContract.args.length!==1)throw Error('UnsupportedEnvelope');
 const native=spec.scValToNative(op.func.invokeContract.args[0]!,xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({name:'ExitIntent'})));
 const intent=intentSchema.parse(jsonSafe(native));
 const draft:ExitDraft={environment:b.environment,epoch:b.epoch,revision:1,intent};
 verifyEnvelopePolicy(signed,draft,b);
 const unsigned=new Transaction(xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({tx:txV1(signed),signatures:[]})),b.networkPassphrase);
 const review:Review={reviewId,draft,profile:b.profile,transactionXdr:unsigned.toXDR(),envelopeDigest:digest(unsigned.toEnvelope().toXDR()),intentHash:intentHash(intent),profileHash:b.profileHash,observedAuthDigest:authDigest(unsigned),preparedLedger:0,preparedTime:'0',expectedReceiveRaw:intent.min_receive,feeMaximumStroops:unsigned.fee};
 return verifySigned(signedXdr,review,b);
}
