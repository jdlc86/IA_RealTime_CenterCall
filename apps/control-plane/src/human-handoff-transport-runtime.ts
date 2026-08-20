import type { HumanHandoffConfig } from "./human-handoff.js";
import { HumanHandoffStore } from "./human-handoff-store.js";
import { conversationLifecyclePortFor } from "./conversation-lifecycle-port.js";

export type HumanHandoffSpeechKind = "ANNOUNCEMENT" | "FAILURE_TERMINAL";
export type HumanHandoffPhase = "WAITING_VAD_OFF" | "ANNOUNCING" | "DIALING" | "FAILURE_SPEAKING" | "TRANSFERRED" | "TERMINATING";
export type ActiveHumanHandoff = Readonly<{ id:string; reason:string; summary?:string; phase:HumanHandoffPhase; speechKind:HumanHandoffSpeechKind|null; speechResponseId:string|null; targetCallControlId:string|null }>;
export type HumanHandoffTransportContext = Readonly<{ sourceCallControlId:string|null; calledNumber:string|null }>;
type MutableActive = { id:string; reason:string; summary?:string; phase:HumanHandoffPhase; speechKind:HumanHandoffSpeechKind|null; speechResponseId:string|null; targetCallControlId:string|null };
type Host = object & { env?:{SUPABASE_URL?:string;SUPABASE_SECRET_KEY?:string}; tenantId?:unknown; socket?:{close?:(code?:number,reason?:string)=>void}|null; diagnostics?:{checkpoint?:(name:string,data?:Record<string,unknown>)=>void;fail?:(name:string,code:string,data?:Record<string,unknown>)=>void} };
const nonEmpty=(v:unknown):string|null=>typeof v==="string"&&v.trim()?v.trim():null;
const copy=(v:MutableActive|null):ActiveHumanHandoff|null=>v?{...v}:null;

export class HumanHandoffTransportRuntime {
  private config:HumanHandoffConfig|undefined;
  private context:HumanHandoffTransportContext={sourceCallControlId:null,calledNumber:null};
  private active:MutableActive|null=null;
  private speechWatchdog:ReturnType<typeof setTimeout>|null=null;
  private transferWatchdog:ReturnType<typeof setTimeout>|null=null;

  setConfig(config:HumanHandoffConfig|undefined):void{this.config=config;}
  getConfig():HumanHandoffConfig|undefined{return this.config;}
  attachTransportContext(sourceCallControlId:string,calledNumber:string):void{this.context={sourceCallControlId,calledNumber};}
  transportContext():HumanHandoffTransportContext{return {...this.context};}
  begin(input:{id:string;reason:string;summary?:string}):boolean{if(this.active)return false;this.active={...input,phase:"WAITING_VAD_OFF",speechKind:null,speechResponseId:null,targetCallControlId:null};return true;}
  snapshot():ActiveHumanHandoff|null{return copy(this.active);}
  setPhase(phase:HumanHandoffPhase):ActiveHumanHandoff|null{if(!this.active)return null;this.active.phase=phase;return copy(this.active);}
  beginSpeech(kind:HumanHandoffSpeechKind):ActiveHumanHandoff|null{if(!this.active)return null;this.active.speechKind=kind;this.active.speechResponseId=null;this.active.phase=kind==="ANNOUNCEMENT"?"ANNOUNCING":"FAILURE_SPEAKING";return copy(this.active);}
  bindSpeechResponse(kind:HumanHandoffSpeechKind,responseId:string):boolean{if(!this.active||this.active.speechKind!==kind||!responseId.trim())return false;if(this.active.speechResponseId&&this.active.speechResponseId!==responseId)return false;this.active.speechResponseId=responseId;return true;}
  clearSpeech(nextPhase?:HumanHandoffPhase):ActiveHumanHandoff|null{if(!this.active)return null;this.active.speechKind=null;this.active.speechResponseId=null;if(nextPhase)this.active.phase=nextPhase;return copy(this.active);}
  setTargetCallControlId(id:string):ActiveHumanHandoff|null{if(this.active&&id.trim())this.active.targetCallControlId=id.trim();return copy(this.active);}
  armSpeechWatchdog(ms:number,onTimeout:()=>void):void{this.cancelSpeechWatchdog();this.speechWatchdog=setTimeout(onTimeout,ms);}
  cancelSpeechWatchdog():void{if(this.speechWatchdog)clearTimeout(this.speechWatchdog);this.speechWatchdog=null;}
  armTransferWatchdog(ms:number,onTimeout:()=>void):void{this.cancelTransferWatchdog();this.transferWatchdog=setTimeout(onTimeout,ms);}
  cancelTransferWatchdog():void{if(this.transferWatchdog)clearTimeout(this.transferWatchdog);this.transferWatchdog=null;}
  beginTerminating():ActiveHumanHandoff|null{if(!this.active||this.active.phase==="TRANSFERRED"||this.active.phase==="TERMINATING")return null;this.cancelSpeechWatchdog();this.cancelTransferWatchdog();this.active.phase="TERMINATING";this.active.speechKind=null;this.active.speechResponseId=null;return copy(this.active);}

  async markTransferred(host:Host,targetCallControlId:string|null):Promise<ActiveHumanHandoff|null>{
    if(!this.active||this.active.phase==="TRANSFERRED"||this.active.phase==="TERMINATING")return null;
    this.cancelTransferWatchdog();this.cancelSpeechWatchdog();this.active.phase="TRANSFERRED";this.active.speechKind=null;this.active.speechResponseId=null;
    if(targetCallControlId&&targetCallControlId!==this.context.sourceCallControlId)this.active.targetCallControlId=targetCallControlId;
    const snapshot=copy(this.active)!;const tenantId=nonEmpty(host.tenantId);
    if(tenantId){try{const env=host.env??{};const store=new HumanHandoffStore({SUPABASE_URL:env.SUPABASE_URL??"",SUPABASE_SECRET_KEY:env.SUPABASE_SECRET_KEY??""});const now=new Date().toISOString();await store.update(snapshot.id,tenantId,{status:"TRANSFERRED",answered_at:now,transfer_ended_at:now,callback_required:false,callback_status:null,target_call_control_id:snapshot.targetCallControlId});}catch(error){host.diagnostics?.fail?.("HUMAN_HANDOFF_TRACE_UPDATE_FAILED_RUNTIME","HANDOFF_TRACE_UPDATE_FAILED",{handoff_id:snapshot.id,error:error instanceof Error?error.message:String(error)});}}
    conversationLifecyclePortFor(host).transportClosed("human_handoff_transferred");
    try{host.socket?.close?.(1000,"human_handoff_transferred");}catch{}
    host.diagnostics?.checkpoint?.("HUMAN_HANDOFF_TRANSFERRED_RUNTIME",{handoff_id:snapshot.id,human_connected:true,ai_sideband_closed:true,callback_required:false,lucia_conversation_resumes:false,state_owner:"human_handoff_transport_runtime",lifecycle_owner:"conversation_lifecycle_port"});
    return snapshot;
  }
}
const runtimes=new WeakMap<object,HumanHandoffTransportRuntime>();
export function humanHandoffTransportRuntimeFor(session:object):HumanHandoffTransportRuntime{let runtime=runtimes.get(session);if(!runtime){runtime=new HumanHandoffTransportRuntime();runtimes.set(session,runtime);}return runtime;}
