"use strict";
// Settings of the global Auto group (leastLoad). Applied to every issued Auto profile; editable via the admin API.
const DEFAULTS=Object.freeze({probe_interval:'2m',probe_sampling:2,probe_timeout:'4s',expected:1,tolerance:0.25,max_rtt:'1500ms'});
const FIELDS=Object.freeze({
 probe_interval:Object.freeze({type:'duration',unit:'ms',min:5000,max:300000,default:DEFAULTS.probe_interval}),
 probe_timeout:Object.freeze({type:'duration',unit:'ms',min:500,max:10000,default:DEFAULTS.probe_timeout}),
 max_rtt:Object.freeze({type:'duration',unit:'ms',min:50,max:10000,default:DEFAULTS.max_rtt}),
 probe_sampling:Object.freeze({type:'integer',unit:'count',min:1,max:5,default:DEFAULTS.probe_sampling}),
 expected:Object.freeze({type:'integer',unit:'count',min:1,max:16,default:DEFAULTS.expected}),
 tolerance:Object.freeze({type:'number',unit:'ratio',min:0,max:1,default:DEFAULTS.tolerance})
});
const CAPABILITY=Object.freeze({version:1,scope:'global_auto',strategy:'leastLoad',application:'next_subscription_refresh',limits_kind:'administrative',fields:FIELDS});
const KEYS=new Set(Object.keys(DEFAULTS));
function durationMs(value,min,max,name){
 if(typeof value!=='string')throw new TypeError(name+' must be a duration');
 const m=/^([1-9]\d*)(ms|s|m)$/.exec(value);
 if(!m)throw new TypeError(name+' must use ms, s or m');
 const n=Number(m[1])*({ms:1,s:1000,m:60000}[m[2]]);
 if(!Number.isSafeInteger(n)||n<min||n>max)throw new RangeError(name+' outside administrative limits');
 return value;
}
function normalizeFastestStability(input=DEFAULTS){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Auto settings must be an object');
 for(const key of Object.keys(input))if(!KEYS.has(key))throw new TypeError('Unknown Auto setting');
 const v={...DEFAULTS,...input};
 for(const key of ['probe_interval','probe_timeout','max_rtt'])durationMs(v[key],FIELDS[key].min,FIELDS[key].max,key);
 for(const key of ['probe_sampling','expected']){
  const {min,max}=FIELDS[key];
  if(!Number.isInteger(v[key])||v[key]<min||v[key]>max)throw new RangeError(key+' outside administrative limits');
 }
 if(typeof v.tolerance!=='number'||!Number.isFinite(v.tolerance)||v.tolerance<0||v.tolerance>1)throw new RangeError('tolerance outside administrative limits');
 return v;
}
function applyFastestStability(config,options){
 const v=normalizeFastestStability(options);
 if(!config?.burstObservatory?.pingConfig||!config.routing?.balancers?.length)throw new Error('Auto profile has no observed balancer');
 Object.assign(config.burstObservatory.pingConfig,{interval:v.probe_interval,sampling:v.probe_sampling,timeout:v.probe_timeout,connectivity:''});
 config.routing.balancers[0].strategy={type:'leastLoad',settings:{expected:v.expected,baselines:[],tolerance:v.tolerance,maxRTT:v.max_rtt}};
 return config;
}
module.exports={DEFAULTS,CAPABILITY,normalizeFastestStability,applyFastestStability};
