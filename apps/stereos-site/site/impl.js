var kh=Object.create;var zi=Object.defineProperty;var $h=Object.getOwnPropertyDescriptor;var Th=Object.getOwnPropertyNames;var Eh=Object.getPrototypeOf,Ch=Object.prototype.hasOwnProperty;var Ye=(e,t)=>()=>{try{return t||e((t={exports:{}}).exports,t),t.exports}catch(n){throw t=0,n}},Ah=(e,t)=>{for(var n in t)zi(e,n,{get:t[n],enumerable:!0})},Oh=(e,t,n,a)=>{if(t&&typeof t=="object"||typeof t=="function")for(let o of Th(t))!Ch.call(e,o)&&o!==n&&zi(e,o,{get:()=>t[o],enumerable:!(a=$h(t,o))||a.enumerable});return e};var X=(e,t,n)=>(n=e!=null?kh(Eh(e)):{},Oh(t||!e||!e.__esModule?zi(n,"default",{value:e,enumerable:!0}):n,e));var Hu=Ye(J=>{"use strict";function Hi(e,t){var n=e.length;e.push(t);e:for(;0<n;){var a=n-1>>>1,o=e[a];if(0<Uo(o,t))e[a]=t,e[n]=o,n=a;else break e}}function st(e){return e.length===0?null:e[0]}function Lo(e){if(e.length===0)return null;var t=e[0],n=e.pop();if(n!==t){e[0]=n;e:for(var a=0,o=e.length,i=o>>>1;a<i;){var s=2*(a+1)-1,l=e[s],u=s+1,c=e[u];if(0>Uo(l,n))u<o&&0>Uo(c,l)?(e[a]=c,e[u]=n,a=u):(e[a]=l,e[s]=n,a=s);else if(u<o&&0>Uo(c,n))e[a]=c,e[u]=n,a=u;else break e}}return t}function Uo(e,t){var n=e.sortIndex-t.sortIndex;return n!==0?n:e.id-t.id}J.unstable_now=void 0;typeof performance=="object"&&typeof performance.now=="function"?(Eu=performance,J.unstable_now=function(){return Eu.now()}):(_i=Date,Cu=_i.now(),J.unstable_now=function(){return _i.now()-Cu});var Eu,_i,Cu,ht=[],Dt=[],Rh=1,Ke=null,ke=3,Ni=!1,_a=!1,Ma=!1,Di=!1,Ru=typeof setTimeout=="function"?setTimeout:null,zu=typeof clearTimeout=="function"?clearTimeout:null,Au=typeof setImmediate<"u"?setImmediate:null;function jo(e){for(var t=st(Dt);t!==null;){if(t.callback===null)Lo(Dt);else if(t.startTime<=e)Lo(Dt),t.sortIndex=t.expirationTime,Hi(ht,t);else break;t=st(Dt)}}function Ui(e){if(Ma=!1,jo(e),!_a)if(st(ht)!==null)_a=!0,Nn||(Nn=!0,Hn());else{var t=st(Dt);t!==null&&ji(Ui,t.startTime-e)}}var Nn=!1,Ba=-1,_u=5,Mu=-1;function Bu(){return Di?!0:!(J.unstable_now()-Mu<_u)}function Mi(){if(Di=!1,Nn){var e=J.unstable_now();Mu=e;var t=!0;try{e:{_a=!1,Ma&&(Ma=!1,zu(Ba),Ba=-1),Ni=!0;var n=ke;try{t:{for(jo(e),Ke=st(ht);Ke!==null&&!(Ke.expirationTime>e&&Bu());){var a=Ke.callback;if(typeof a=="function"){Ke.callback=null,ke=Ke.priorityLevel;var o=a(Ke.expirationTime<=e);if(e=J.unstable_now(),typeof o=="function"){Ke.callback=o,jo(e),t=!0;break t}Ke===st(ht)&&Lo(ht),jo(e)}else Lo(ht);Ke=st(ht)}if(Ke!==null)t=!0;else{var i=st(Dt);i!==null&&ji(Ui,i.startTime-e),t=!1}}break e}finally{Ke=null,ke=n,Ni=!1}t=void 0}}finally{t?Hn():Nn=!1}}}var Hn;typeof Au=="function"?Hn=function(){Au(Mi)}:typeof MessageChannel<"u"?(Bi=new MessageChannel,Ou=Bi.port2,Bi.port1.onmessage=Mi,Hn=function(){Ou.postMessage(null)}):Hn=function(){Ru(Mi,0)};var Bi,Ou;function ji(e,t){Ba=Ru(function(){e(J.unstable_now())},t)}J.unstable_IdlePriority=5;J.unstable_ImmediatePriority=1;J.unstable_LowPriority=4;J.unstable_NormalPriority=3;J.unstable_Profiling=null;J.unstable_UserBlockingPriority=2;J.unstable_cancelCallback=function(e){e.callback=null};J.unstable_forceFrameRate=function(e){0>e||125<e?console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"):_u=0<e?Math.floor(1e3/e):5};J.unstable_getCurrentPriorityLevel=function(){return ke};J.unstable_next=function(e){switch(ke){case 1:case 2:case 3:var t=3;break;default:t=ke}var n=ke;ke=t;try{return e()}finally{ke=n}};J.unstable_requestPaint=function(){Di=!0};J.unstable_runWithPriority=function(e,t){switch(e){case 1:case 2:case 3:case 4:case 5:break;default:e=3}var n=ke;ke=e;try{return t()}finally{ke=n}};J.unstable_scheduleCallback=function(e,t,n){var a=J.unstable_now();switch(typeof n=="object"&&n!==null?(n=n.delay,n=typeof n=="number"&&0<n?a+n:a):n=a,e){case 1:var o=-1;break;case 2:o=250;break;case 5:o=1073741823;break;case 4:o=1e4;break;default:o=5e3}return o=n+o,e={id:Rh++,callback:t,priorityLevel:e,startTime:n,expirationTime:o,sortIndex:-1},n>a?(e.sortIndex=n,Hi(Dt,e),st(ht)===null&&e===st(Dt)&&(Ma?(zu(Ba),Ba=-1):Ma=!0,ji(Ui,n-a))):(e.sortIndex=o,Hi(ht,e),_a||Ni||(_a=!0,Nn||(Nn=!0,Hn()))),e};J.unstable_shouldYield=Bu;J.unstable_wrapCallback=function(e){var t=ke;return function(){var n=ke;ke=t;try{return e.apply(this,arguments)}finally{ke=n}}}});var Du=Ye((Lv,Nu)=>{"use strict";Nu.exports=Hu()});var Xu=Ye(E=>{"use strict";var Fi=Symbol.for("react.transitional.element"),zh=Symbol.for("react.portal"),_h=Symbol.for("react.fragment"),Mh=Symbol.for("react.strict_mode"),Bh=Symbol.for("react.profiler"),Hh=Symbol.for("react.consumer"),Nh=Symbol.for("react.context"),Dh=Symbol.for("react.forward_ref"),Uh=Symbol.for("react.suspense"),jh=Symbol.for("react.memo"),Fu=Symbol.for("react.lazy"),Lh=Symbol.for("react.activity"),Uu=Symbol.iterator;function qh(e){return e===null||typeof e!="object"?null:(e=Uu&&e[Uu]||e["@@iterator"],typeof e=="function"?e:null)}var Gu={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},Vu=Object.assign,Yu={};function Un(e,t,n){this.props=e,this.context=t,this.refs=Yu,this.updater=n||Gu}Un.prototype.isReactComponent={};Un.prototype.setState=function(e,t){if(typeof e!="object"&&typeof e!="function"&&e!=null)throw Error("takes an object of state variables to update or a function which returns an object of state variables.");this.updater.enqueueSetState(this,e,t,"setState")};Un.prototype.forceUpdate=function(e){this.updater.enqueueForceUpdate(this,e,"forceUpdate")};function Ku(){}Ku.prototype=Un.prototype;function Gi(e,t,n){this.props=e,this.context=t,this.refs=Yu,this.updater=n||Gu}var Vi=Gi.prototype=new Ku;Vi.constructor=Gi;Vu(Vi,Un.prototype);Vi.isPureReactComponent=!0;var ju=Array.isArray;function qi(){}var Q={H:null,A:null,T:null,S:null},Pu=Object.prototype.hasOwnProperty;function Yi(e,t,n){var a=n.ref;return{$$typeof:Fi,type:e,key:t,ref:a!==void 0?a:null,props:n}}function Fh(e,t){return Yi(e.type,t,e.props)}function Ki(e){return typeof e=="object"&&e!==null&&e.$$typeof===Fi}function Gh(e){var t={"=":"=0",":":"=2"};return"$"+e.replace(/[=:]/g,function(n){return t[n]})}var Lu=/\/+/g;function Li(e,t){return typeof e=="object"&&e!==null&&e.key!=null?Gh(""+e.key):t.toString(36)}function Vh(e){switch(e.status){case"fulfilled":return e.value;case"rejected":throw e.reason;default:switch(typeof e.status=="string"?e.then(qi,qi):(e.status="pending",e.then(function(t){e.status==="pending"&&(e.status="fulfilled",e.value=t)},function(t){e.status==="pending"&&(e.status="rejected",e.reason=t)})),e.status){case"fulfilled":return e.value;case"rejected":throw e.reason}}throw e}function Dn(e,t,n,a,o){var i=typeof e;(i==="undefined"||i==="boolean")&&(e=null);var s=!1;if(e===null)s=!0;else switch(i){case"bigint":case"string":case"number":s=!0;break;case"object":switch(e.$$typeof){case Fi:case zh:s=!0;break;case Fu:return s=e._init,Dn(s(e._payload),t,n,a,o)}}if(s)return o=o(e),s=a===""?"."+Li(e,0):a,ju(o)?(n="",s!=null&&(n=s.replace(Lu,"$&/")+"/"),Dn(o,t,n,"",function(c){return c})):o!=null&&(Ki(o)&&(o=Fh(o,n+(o.key==null||e&&e.key===o.key?"":(""+o.key).replace(Lu,"$&/")+"/")+s)),t.push(o)),1;s=0;var l=a===""?".":a+":";if(ju(e))for(var u=0;u<e.length;u++)a=e[u],i=l+Li(a,u),s+=Dn(a,t,n,i,o);else if(u=qh(e),typeof u=="function")for(e=u.call(e),u=0;!(a=e.next()).done;)a=a.value,i=l+Li(a,u++),s+=Dn(a,t,n,i,o);else if(i==="object"){if(typeof e.then=="function")return Dn(Vh(e),t,n,a,o);throw t=String(e),Error("Objects are not valid as a React child (found: "+(t==="[object Object]"?"object with keys {"+Object.keys(e).join(", ")+"}":t)+"). If you meant to render a collection of children, use an array instead.")}return s}function qo(e,t,n){if(e==null)return e;var a=[],o=0;return Dn(e,a,"","",function(i){return t.call(n,i,o++)}),a}function Yh(e){if(e._status===-1){var t=e._result;t=t(),t.then(function(n){(e._status===0||e._status===-1)&&(e._status=1,e._result=n)},function(n){(e._status===0||e._status===-1)&&(e._status=2,e._result=n)}),e._status===-1&&(e._status=0,e._result=t)}if(e._status===1)return e._result.default;throw e._result}var qu=typeof reportError=="function"?reportError:function(e){if(typeof window=="object"&&typeof window.ErrorEvent=="function"){var t=new window.ErrorEvent("error",{bubbles:!0,cancelable:!0,message:typeof e=="object"&&e!==null&&typeof e.message=="string"?String(e.message):String(e),error:e});if(!window.dispatchEvent(t))return}else if(typeof process=="object"&&typeof process.emit=="function"){process.emit("uncaughtException",e);return}console.error(e)},Kh={map:qo,forEach:function(e,t,n){qo(e,function(){t.apply(this,arguments)},n)},count:function(e){var t=0;return qo(e,function(){t++}),t},toArray:function(e){return qo(e,function(t){return t})||[]},only:function(e){if(!Ki(e))throw Error("React.Children.only expected to receive a single React element child.");return e}};E.Activity=Lh;E.Children=Kh;E.Component=Un;E.Fragment=_h;E.Profiler=Bh;E.PureComponent=Gi;E.StrictMode=Mh;E.Suspense=Uh;E.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=Q;E.__COMPILER_RUNTIME={__proto__:null,c:function(e){return Q.H.useMemoCache(e)}};E.cache=function(e){return function(){return e.apply(null,arguments)}};E.cacheSignal=function(){return null};E.cloneElement=function(e,t,n){if(e==null)throw Error("The argument must be a React element, but you passed "+e+".");var a=Vu({},e.props),o=e.key;if(t!=null)for(i in t.key!==void 0&&(o=""+t.key),t)!Pu.call(t,i)||i==="key"||i==="__self"||i==="__source"||i==="ref"&&t.ref===void 0||(a[i]=t[i]);var i=arguments.length-2;if(i===1)a.children=n;else if(1<i){for(var s=Array(i),l=0;l<i;l++)s[l]=arguments[l+2];a.children=s}return Yi(e.type,o,a)};E.createContext=function(e){return e={$$typeof:Nh,_currentValue:e,_currentValue2:e,_threadCount:0,Provider:null,Consumer:null},e.Provider=e,e.Consumer={$$typeof:Hh,_context:e},e};E.createElement=function(e,t,n){var a,o={},i=null;if(t!=null)for(a in t.key!==void 0&&(i=""+t.key),t)Pu.call(t,a)&&a!=="key"&&a!=="__self"&&a!=="__source"&&(o[a]=t[a]);var s=arguments.length-2;if(s===1)o.children=n;else if(1<s){for(var l=Array(s),u=0;u<s;u++)l[u]=arguments[u+2];o.children=l}if(e&&e.defaultProps)for(a in s=e.defaultProps,s)o[a]===void 0&&(o[a]=s[a]);return Yi(e,i,o)};E.createRef=function(){return{current:null}};E.forwardRef=function(e){return{$$typeof:Dh,render:e}};E.isValidElement=Ki;E.lazy=function(e){return{$$typeof:Fu,_payload:{_status:-1,_result:e},_init:Yh}};E.memo=function(e,t){return{$$typeof:jh,type:e,compare:t===void 0?null:t}};E.startTransition=function(e){var t=Q.T,n={};Q.T=n;try{var a=e(),o=Q.S;o!==null&&o(n,a),typeof a=="object"&&a!==null&&typeof a.then=="function"&&a.then(qi,qu)}catch(i){qu(i)}finally{t!==null&&n.types!==null&&(t.types=n.types),Q.T=t}};E.unstable_useCacheRefresh=function(){return Q.H.useCacheRefresh()};E.use=function(e){return Q.H.use(e)};E.useActionState=function(e,t,n){return Q.H.useActionState(e,t,n)};E.useCallback=function(e,t){return Q.H.useCallback(e,t)};E.useContext=function(e){return Q.H.useContext(e)};E.useDebugValue=function(){};E.useDeferredValue=function(e,t){return Q.H.useDeferredValue(e,t)};E.useEffect=function(e,t){return Q.H.useEffect(e,t)};E.useEffectEvent=function(e){return Q.H.useEffectEvent(e)};E.useId=function(){return Q.H.useId()};E.useImperativeHandle=function(e,t,n){return Q.H.useImperativeHandle(e,t,n)};E.useInsertionEffect=function(e,t){return Q.H.useInsertionEffect(e,t)};E.useLayoutEffect=function(e,t){return Q.H.useLayoutEffect(e,t)};E.useMemo=function(e,t){return Q.H.useMemo(e,t)};E.useOptimistic=function(e,t){return Q.H.useOptimistic(e,t)};E.useReducer=function(e,t,n){return Q.H.useReducer(e,t,n)};E.useRef=function(e){return Q.H.useRef(e)};E.useState=function(e){return Q.H.useState(e)};E.useSyncExternalStore=function(e,t,n){return Q.H.useSyncExternalStore(e,t,n)};E.useTransition=function(){return Q.H.useTransition()};E.version="19.2.7"});var mt=Ye((Fv,Qu)=>{"use strict";Qu.exports=Xu()});var Zu=Ye(Te=>{"use strict";var Ph=mt();function Iu(e){var t="https://react.dev/errors/"+e;if(1<arguments.length){t+="?args[]="+encodeURIComponent(arguments[1]);for(var n=2;n<arguments.length;n++)t+="&args[]="+encodeURIComponent(arguments[n])}return"Minified React error #"+e+"; visit "+t+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}function Ut(){}var $e={d:{f:Ut,r:function(){throw Error(Iu(522))},D:Ut,C:Ut,L:Ut,m:Ut,X:Ut,S:Ut,M:Ut},p:0,findDOMNode:null},Xh=Symbol.for("react.portal");function Qh(e,t,n){var a=3<arguments.length&&arguments[3]!==void 0?arguments[3]:null;return{$$typeof:Xh,key:a==null?null:""+a,children:e,containerInfo:t,implementation:n}}var Ha=Ph.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;function Fo(e,t){if(e==="font")return"";if(typeof t=="string")return t==="use-credentials"?t:""}Te.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=$e;Te.createPortal=function(e,t){var n=2<arguments.length&&arguments[2]!==void 0?arguments[2]:null;if(!t||t.nodeType!==1&&t.nodeType!==9&&t.nodeType!==11)throw Error(Iu(299));return Qh(e,t,null,n)};Te.flushSync=function(e){var t=Ha.T,n=$e.p;try{if(Ha.T=null,$e.p=2,e)return e()}finally{Ha.T=t,$e.p=n,$e.d.f()}};Te.preconnect=function(e,t){typeof e=="string"&&(t?(t=t.crossOrigin,t=typeof t=="string"?t==="use-credentials"?t:"":void 0):t=null,$e.d.C(e,t))};Te.prefetchDNS=function(e){typeof e=="string"&&$e.d.D(e)};Te.preinit=function(e,t){if(typeof e=="string"&&t&&typeof t.as=="string"){var n=t.as,a=Fo(n,t.crossOrigin),o=typeof t.integrity=="string"?t.integrity:void 0,i=typeof t.fetchPriority=="string"?t.fetchPriority:void 0;n==="style"?$e.d.S(e,typeof t.precedence=="string"?t.precedence:void 0,{crossOrigin:a,integrity:o,fetchPriority:i}):n==="script"&&$e.d.X(e,{crossOrigin:a,integrity:o,fetchPriority:i,nonce:typeof t.nonce=="string"?t.nonce:void 0})}};Te.preinitModule=function(e,t){if(typeof e=="string")if(typeof t=="object"&&t!==null){if(t.as==null||t.as==="script"){var n=Fo(t.as,t.crossOrigin);$e.d.M(e,{crossOrigin:n,integrity:typeof t.integrity=="string"?t.integrity:void 0,nonce:typeof t.nonce=="string"?t.nonce:void 0})}}else t==null&&$e.d.M(e)};Te.preload=function(e,t){if(typeof e=="string"&&typeof t=="object"&&t!==null&&typeof t.as=="string"){var n=t.as,a=Fo(n,t.crossOrigin);$e.d.L(e,n,{crossOrigin:a,integrity:typeof t.integrity=="string"?t.integrity:void 0,nonce:typeof t.nonce=="string"?t.nonce:void 0,type:typeof t.type=="string"?t.type:void 0,fetchPriority:typeof t.fetchPriority=="string"?t.fetchPriority:void 0,referrerPolicy:typeof t.referrerPolicy=="string"?t.referrerPolicy:void 0,imageSrcSet:typeof t.imageSrcSet=="string"?t.imageSrcSet:void 0,imageSizes:typeof t.imageSizes=="string"?t.imageSizes:void 0,media:typeof t.media=="string"?t.media:void 0})}};Te.preloadModule=function(e,t){if(typeof e=="string")if(t){var n=Fo(t.as,t.crossOrigin);$e.d.m(e,{as:typeof t.as=="string"&&t.as!=="script"?t.as:void 0,crossOrigin:n,integrity:typeof t.integrity=="string"?t.integrity:void 0})}else $e.d.m(e)};Te.requestFormReset=function(e){$e.d.r(e)};Te.unstable_batchedUpdates=function(e,t){return e(t)};Te.useFormState=function(e,t,n){return Ha.H.useFormState(e,t,n)};Te.useFormStatus=function(){return Ha.H.useHostTransitionStatus()};Te.version="19.2.7"});var ed=Ye((Vv,Ju)=>{"use strict";function Wu(){if(!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>"u"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!="function"))try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(Wu)}catch(e){console.error(e)}}Wu(),Ju.exports=Zu()});var fg=Ye(fi=>{"use strict";var ce=Du(),Ec=mt(),Ih=ed();function y(e){var t="https://react.dev/errors/"+e;if(1<arguments.length){t+="?args[]="+encodeURIComponent(arguments[1]);for(var n=2;n<arguments.length;n++)t+="&args[]="+encodeURIComponent(arguments[n])}return"Minified React error #"+e+"; visit "+t+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}function Cc(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11)}function So(e){var t=e,n=e;if(e.alternate)for(;t.return;)t=t.return;else{e=t;do t=e,(t.flags&4098)!==0&&(n=t.return),e=t.return;while(e)}return t.tag===3?n:null}function Ac(e){if(e.tag===13){var t=e.memoizedState;if(t===null&&(e=e.alternate,e!==null&&(t=e.memoizedState)),t!==null)return t.dehydrated}return null}function Oc(e){if(e.tag===31){var t=e.memoizedState;if(t===null&&(e=e.alternate,e!==null&&(t=e.memoizedState)),t!==null)return t.dehydrated}return null}function td(e){if(So(e)!==e)throw Error(y(188))}function Zh(e){var t=e.alternate;if(!t){if(t=So(e),t===null)throw Error(y(188));return t!==e?null:e}for(var n=e,a=t;;){var o=n.return;if(o===null)break;var i=o.alternate;if(i===null){if(a=o.return,a!==null){n=a;continue}break}if(o.child===i.child){for(i=o.child;i;){if(i===n)return td(o),e;if(i===a)return td(o),t;i=i.sibling}throw Error(y(188))}if(n.return!==a.return)n=o,a=i;else{for(var s=!1,l=o.child;l;){if(l===n){s=!0,n=o,a=i;break}if(l===a){s=!0,a=o,n=i;break}l=l.sibling}if(!s){for(l=i.child;l;){if(l===n){s=!0,n=i,a=o;break}if(l===a){s=!0,a=i,n=o;break}l=l.sibling}if(!s)throw Error(y(189))}}if(n.alternate!==a)throw Error(y(190))}if(n.tag!==3)throw Error(y(188));return n.stateNode.current===n?e:t}function Rc(e){var t=e.tag;if(t===5||t===26||t===27||t===6)return e;for(e=e.child;e!==null;){if(t=Rc(e),t!==null)return t;e=e.sibling}return null}var W=Object.assign,Wh=Symbol.for("react.element"),Go=Symbol.for("react.transitional.element"),Ga=Symbol.for("react.portal"),Vn=Symbol.for("react.fragment"),zc=Symbol.for("react.strict_mode"),Es=Symbol.for("react.profiler"),_c=Symbol.for("react.consumer"),$t=Symbol.for("react.context"),wl=Symbol.for("react.forward_ref"),Cs=Symbol.for("react.suspense"),As=Symbol.for("react.suspense_list"),Sl=Symbol.for("react.memo"),jt=Symbol.for("react.lazy"),Os=Symbol.for("react.activity"),Jh=Symbol.for("react.memo_cache_sentinel"),nd=Symbol.iterator;function Na(e){return e===null||typeof e!="object"?null:(e=nd&&e[nd]||e["@@iterator"],typeof e=="function"?e:null)}var em=Symbol.for("react.client.reference");function Rs(e){if(e==null)return null;if(typeof e=="function")return e.$$typeof===em?null:e.displayName||e.name||null;if(typeof e=="string")return e;switch(e){case Vn:return"Fragment";case Es:return"Profiler";case zc:return"StrictMode";case Cs:return"Suspense";case As:return"SuspenseList";case Os:return"Activity"}if(typeof e=="object")switch(e.$$typeof){case Ga:return"Portal";case $t:return e.displayName||"Context";case _c:return(e._context.displayName||"Context")+".Consumer";case wl:var t=e.render;return e=e.displayName,e||(e=t.displayName||t.name||"",e=e!==""?"ForwardRef("+e+")":"ForwardRef"),e;case Sl:return t=e.displayName||null,t!==null?t:Rs(e.type)||"Memo";case jt:t=e._payload,e=e._init;try{return Rs(e(t))}catch{}}return null}var Va=Array.isArray,T=Ec.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,U=Ih.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,xn={pending:!1,data:null,method:null,action:null},zs=[],Yn=-1;function pt(e){return{current:e}}function ge(e){0>Yn||(e.current=zs[Yn],zs[Yn]=null,Yn--)}function K(e,t){Yn++,zs[Yn]=e.current,e.current=t}var ct=pt(null),so=pt(null),It=pt(null),Sr=pt(null);function kr(e,t){switch(K(It,t),K(so,e),K(ct,null),t.nodeType){case 9:case 11:e=(e=t.documentElement)&&(e=e.namespaceURI)?uc(e):0;break;default:if(e=t.tagName,t=t.namespaceURI)t=uc(t),e=Jf(t,e);else switch(e){case"svg":e=1;break;case"math":e=2;break;default:e=0}}ge(ct),K(ct,e)}function ua(){ge(ct),ge(so),ge(It)}function _s(e){e.memoizedState!==null&&K(Sr,e);var t=ct.current,n=Jf(t,e.type);t!==n&&(K(so,e),K(ct,n))}function $r(e){so.current===e&&(ge(ct),ge(so)),Sr.current===e&&(ge(Sr),vo._currentValue=xn)}var Pi,ad;function gn(e){if(Pi===void 0)try{throw Error()}catch(n){var t=n.stack.trim().match(/\n( *(at )?)/);Pi=t&&t[1]||"",ad=-1<n.stack.indexOf(`
    at`)?" (<anonymous>)":-1<n.stack.indexOf("@")?"@unknown:0:0":""}return`
`+Pi+e+ad}var Xi=!1;function Qi(e,t){if(!e||Xi)return"";Xi=!0;var n=Error.prepareStackTrace;Error.prepareStackTrace=void 0;try{var a={DetermineComponentFrameRoot:function(){try{if(t){var b=function(){throw Error()};if(Object.defineProperty(b.prototype,"props",{set:function(){throw Error()}}),typeof Reflect=="object"&&Reflect.construct){try{Reflect.construct(b,[])}catch(h){var f=h}Reflect.construct(e,[],b)}else{try{b.call()}catch(h){f=h}e.call(b.prototype)}}else{try{throw Error()}catch(h){f=h}(b=e())&&typeof b.catch=="function"&&b.catch(function(){})}}catch(h){if(h&&f&&typeof h.stack=="string")return[h.stack,f.stack]}return[null,null]}};a.DetermineComponentFrameRoot.displayName="DetermineComponentFrameRoot";var o=Object.getOwnPropertyDescriptor(a.DetermineComponentFrameRoot,"name");o&&o.configurable&&Object.defineProperty(a.DetermineComponentFrameRoot,"name",{value:"DetermineComponentFrameRoot"});var i=a.DetermineComponentFrameRoot(),s=i[0],l=i[1];if(s&&l){var u=s.split(`
`),c=l.split(`
`);for(o=a=0;a<u.length&&!u[a].includes("DetermineComponentFrameRoot");)a++;for(;o<c.length&&!c[o].includes("DetermineComponentFrameRoot");)o++;if(a===u.length||o===c.length)for(a=u.length-1,o=c.length-1;1<=a&&0<=o&&u[a]!==c[o];)o--;for(;1<=a&&0<=o;a--,o--)if(u[a]!==c[o]){if(a!==1||o!==1)do if(a--,o--,0>o||u[a]!==c[o]){var m=`
`+u[a].replace(" at new "," at ");return e.displayName&&m.includes("<anonymous>")&&(m=m.replace("<anonymous>",e.displayName)),m}while(1<=a&&0<=o);break}}}finally{Xi=!1,Error.prepareStackTrace=n}return(n=e?e.displayName||e.name:"")?gn(n):""}function tm(e,t){switch(e.tag){case 26:case 27:case 5:return gn(e.type);case 16:return gn("Lazy");case 13:return e.child!==t&&t!==null?gn("Suspense Fallback"):gn("Suspense");case 19:return gn("SuspenseList");case 0:case 15:return Qi(e.type,!1);case 11:return Qi(e.type.render,!1);case 1:return Qi(e.type,!0);case 31:return gn("Activity");default:return""}}function od(e){try{var t="",n=null;do t+=tm(e,n),n=e,e=e.return;while(e);return t}catch(a){return`
Error generating stack: `+a.message+`
`+a.stack}}var Ms=Object.prototype.hasOwnProperty,kl=ce.unstable_scheduleCallback,Ii=ce.unstable_cancelCallback,nm=ce.unstable_shouldYield,am=ce.unstable_requestPaint,je=ce.unstable_now,om=ce.unstable_getCurrentPriorityLevel,Mc=ce.unstable_ImmediatePriority,Bc=ce.unstable_UserBlockingPriority,Tr=ce.unstable_NormalPriority,rm=ce.unstable_LowPriority,Hc=ce.unstable_IdlePriority,im=ce.log,sm=ce.unstable_setDisableYieldValue,ko=null,Le=null;function Yt(e){if(typeof im=="function"&&sm(e),Le&&typeof Le.setStrictMode=="function")try{Le.setStrictMode(ko,e)}catch{}}var qe=Math.clz32?Math.clz32:dm,lm=Math.log,um=Math.LN2;function dm(e){return e>>>=0,e===0?32:31-(lm(e)/um|0)|0}var Vo=256,Yo=262144,Ko=4194304;function hn(e){var t=e&42;if(t!==0)return t;switch(e&-e){case 1:return 1;case 2:return 2;case 4:return 4;case 8:return 8;case 16:return 16;case 32:return 32;case 64:return 64;case 128:return 128;case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:return e&261888;case 262144:case 524288:case 1048576:case 2097152:return e&3932160;case 4194304:case 8388608:case 16777216:case 33554432:return e&62914560;case 67108864:return 67108864;case 134217728:return 134217728;case 268435456:return 268435456;case 536870912:return 536870912;case 1073741824:return 0;default:return e}}function Zr(e,t,n){var a=e.pendingLanes;if(a===0)return 0;var o=0,i=e.suspendedLanes,s=e.pingedLanes;e=e.warmLanes;var l=a&134217727;return l!==0?(a=l&~i,a!==0?o=hn(a):(s&=l,s!==0?o=hn(s):n||(n=l&~e,n!==0&&(o=hn(n))))):(l=a&~i,l!==0?o=hn(l):s!==0?o=hn(s):n||(n=a&~e,n!==0&&(o=hn(n)))),o===0?0:t!==0&&t!==o&&(t&i)===0&&(i=o&-o,n=t&-t,i>=n||i===32&&(n&4194048)!==0)?t:o}function $o(e,t){return(e.pendingLanes&~(e.suspendedLanes&~e.pingedLanes)&t)===0}function cm(e,t){switch(e){case 1:case 2:case 4:case 8:case 64:return t+250;case 16:case 32:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return t+5e3;case 4194304:case 8388608:case 16777216:case 33554432:return-1;case 67108864:case 134217728:case 268435456:case 536870912:case 1073741824:return-1;default:return-1}}function Nc(){var e=Ko;return Ko<<=1,(Ko&62914560)===0&&(Ko=4194304),e}function Zi(e){for(var t=[],n=0;31>n;n++)t.push(e);return t}function To(e,t){e.pendingLanes|=t,t!==268435456&&(e.suspendedLanes=0,e.pingedLanes=0,e.warmLanes=0)}function pm(e,t,n,a,o,i){var s=e.pendingLanes;e.pendingLanes=n,e.suspendedLanes=0,e.pingedLanes=0,e.warmLanes=0,e.expiredLanes&=n,e.entangledLanes&=n,e.errorRecoveryDisabledLanes&=n,e.shellSuspendCounter=0;var l=e.entanglements,u=e.expirationTimes,c=e.hiddenUpdates;for(n=s&~n;0<n;){var m=31-qe(n),b=1<<m;l[m]=0,u[m]=-1;var f=c[m];if(f!==null)for(c[m]=null,m=0;m<f.length;m++){var h=f[m];h!==null&&(h.lane&=-536870913)}n&=~b}a!==0&&Dc(e,a,0),i!==0&&o===0&&e.tag!==0&&(e.suspendedLanes|=i&~(s&~t))}function Dc(e,t,n){e.pendingLanes|=t,e.suspendedLanes&=~t;var a=31-qe(t);e.entangledLanes|=t,e.entanglements[a]=e.entanglements[a]|1073741824|n&261930}function Uc(e,t){var n=e.entangledLanes|=t;for(e=e.entanglements;n;){var a=31-qe(n),o=1<<a;o&t|e[a]&t&&(e[a]|=t),n&=~o}}function jc(e,t){var n=t&-t;return n=(n&42)!==0?1:$l(n),(n&(e.suspendedLanes|t))!==0?0:n}function $l(e){switch(e){case 2:e=1;break;case 8:e=4;break;case 32:e=16;break;case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:case 4194304:case 8388608:case 16777216:case 33554432:e=128;break;case 268435456:e=134217728;break;default:e=0}return e}function Tl(e){return e&=-e,2<e?8<e?(e&134217727)!==0?32:268435456:8:2}function Lc(){var e=U.p;return e!==0?e:(e=window.event,e===void 0?32:dg(e.type))}function rd(e,t){var n=U.p;try{return U.p=e,t()}finally{U.p=n}}var dn=Math.random().toString(36).slice(2),be="__reactFiber$"+dn,Me="__reactProps$"+dn,ya="__reactContainer$"+dn,Bs="__reactEvents$"+dn,fm="__reactListeners$"+dn,gm="__reactHandles$"+dn,id="__reactResources$"+dn,Eo="__reactMarker$"+dn;function El(e){delete e[be],delete e[Me],delete e[Bs],delete e[fm],delete e[gm]}function Kn(e){var t=e[be];if(t)return t;for(var n=e.parentNode;n;){if(t=n[ya]||n[be]){if(n=t.alternate,t.child!==null||n!==null&&n.child!==null)for(e=gc(e);e!==null;){if(n=e[be])return n;e=gc(e)}return t}e=n,n=e.parentNode}return null}function wa(e){if(e=e[be]||e[ya]){var t=e.tag;if(t===5||t===6||t===13||t===31||t===26||t===27||t===3)return e}return null}function Ya(e){var t=e.tag;if(t===5||t===26||t===27||t===6)return e.stateNode;throw Error(y(33))}function na(e){var t=e[id];return t||(t=e[id]={hoistableStyles:new Map,hoistableScripts:new Map}),t}function fe(e){e[Eo]=!0}var qc=new Set,Fc={};function An(e,t){da(e,t),da(e+"Capture",t)}function da(e,t){for(Fc[e]=t,e=0;e<t.length;e++)qc.add(t[e])}var hm=RegExp("^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$"),sd={},ld={};function mm(e){return Ms.call(ld,e)?!0:Ms.call(sd,e)?!1:hm.test(e)?ld[e]=!0:(sd[e]=!0,!1)}function sr(e,t,n){if(mm(t))if(n===null)e.removeAttribute(t);else{switch(typeof n){case"undefined":case"function":case"symbol":e.removeAttribute(t);return;case"boolean":var a=t.toLowerCase().slice(0,5);if(a!=="data-"&&a!=="aria-"){e.removeAttribute(t);return}}e.setAttribute(t,""+n)}}function Po(e,t,n){if(n===null)e.removeAttribute(t);else{switch(typeof n){case"undefined":case"function":case"symbol":case"boolean":e.removeAttribute(t);return}e.setAttribute(t,""+n)}}function bt(e,t,n,a){if(a===null)e.removeAttribute(n);else{switch(typeof a){case"undefined":case"function":case"symbol":case"boolean":e.removeAttribute(n);return}e.setAttributeNS(t,n,""+a)}}function Xe(e){switch(typeof e){case"bigint":case"boolean":case"number":case"string":case"undefined":return e;case"object":return e;default:return""}}function Gc(e){var t=e.type;return(e=e.nodeName)&&e.toLowerCase()==="input"&&(t==="checkbox"||t==="radio")}function bm(e,t,n){var a=Object.getOwnPropertyDescriptor(e.constructor.prototype,t);if(!e.hasOwnProperty(t)&&typeof a<"u"&&typeof a.get=="function"&&typeof a.set=="function"){var o=a.get,i=a.set;return Object.defineProperty(e,t,{configurable:!0,get:function(){return o.call(this)},set:function(s){n=""+s,i.call(this,s)}}),Object.defineProperty(e,t,{enumerable:a.enumerable}),{getValue:function(){return n},setValue:function(s){n=""+s},stopTracking:function(){e._valueTracker=null,delete e[t]}}}}function Hs(e){if(!e._valueTracker){var t=Gc(e)?"checked":"value";e._valueTracker=bm(e,t,""+e[t])}}function Vc(e){if(!e)return!1;var t=e._valueTracker;if(!t)return!0;var n=t.getValue(),a="";return e&&(a=Gc(e)?e.checked?"true":"false":e.value),e=a,e!==n?(t.setValue(e),!0):!1}function Er(e){if(e=e||(typeof document<"u"?document:void 0),typeof e>"u")return null;try{return e.activeElement||e.body}catch{return e.body}}var xm=/[\n"\\]/g;function Ze(e){return e.replace(xm,function(t){return"\\"+t.charCodeAt(0).toString(16)+" "})}function Ns(e,t,n,a,o,i,s,l){e.name="",s!=null&&typeof s!="function"&&typeof s!="symbol"&&typeof s!="boolean"?e.type=s:e.removeAttribute("type"),t!=null?s==="number"?(t===0&&e.value===""||e.value!=t)&&(e.value=""+Xe(t)):e.value!==""+Xe(t)&&(e.value=""+Xe(t)):s!=="submit"&&s!=="reset"||e.removeAttribute("value"),t!=null?Ds(e,s,Xe(t)):n!=null?Ds(e,s,Xe(n)):a!=null&&e.removeAttribute("value"),o==null&&i!=null&&(e.defaultChecked=!!i),o!=null&&(e.checked=o&&typeof o!="function"&&typeof o!="symbol"),l!=null&&typeof l!="function"&&typeof l!="symbol"&&typeof l!="boolean"?e.name=""+Xe(l):e.removeAttribute("name")}function Yc(e,t,n,a,o,i,s,l){if(i!=null&&typeof i!="function"&&typeof i!="symbol"&&typeof i!="boolean"&&(e.type=i),t!=null||n!=null){if(!(i!=="submit"&&i!=="reset"||t!=null)){Hs(e);return}n=n!=null?""+Xe(n):"",t=t!=null?""+Xe(t):n,l||t===e.value||(e.value=t),e.defaultValue=t}a=a??o,a=typeof a!="function"&&typeof a!="symbol"&&!!a,e.checked=l?e.checked:!!a,e.defaultChecked=!!a,s!=null&&typeof s!="function"&&typeof s!="symbol"&&typeof s!="boolean"&&(e.name=s),Hs(e)}function Ds(e,t,n){t==="number"&&Er(e.ownerDocument)===e||e.defaultValue===""+n||(e.defaultValue=""+n)}function aa(e,t,n,a){if(e=e.options,t){t={};for(var o=0;o<n.length;o++)t["$"+n[o]]=!0;for(n=0;n<e.length;n++)o=t.hasOwnProperty("$"+e[n].value),e[n].selected!==o&&(e[n].selected=o),o&&a&&(e[n].defaultSelected=!0)}else{for(n=""+Xe(n),t=null,o=0;o<e.length;o++){if(e[o].value===n){e[o].selected=!0,a&&(e[o].defaultSelected=!0);return}t!==null||e[o].disabled||(t=e[o])}t!==null&&(t.selected=!0)}}function Kc(e,t,n){if(t!=null&&(t=""+Xe(t),t!==e.value&&(e.value=t),n==null)){e.defaultValue!==t&&(e.defaultValue=t);return}e.defaultValue=n!=null?""+Xe(n):""}function Pc(e,t,n,a){if(t==null){if(a!=null){if(n!=null)throw Error(y(92));if(Va(a)){if(1<a.length)throw Error(y(93));a=a[0]}n=a}n==null&&(n=""),t=n}n=Xe(t),e.defaultValue=n,a=e.textContent,a===n&&a!==""&&a!==null&&(e.value=a),Hs(e)}function ca(e,t){if(t){var n=e.firstChild;if(n&&n===e.lastChild&&n.nodeType===3){n.nodeValue=t;return}}e.textContent=t}var vm=new Set("animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp".split(" "));function ud(e,t,n){var a=t.indexOf("--")===0;n==null||typeof n=="boolean"||n===""?a?e.setProperty(t,""):t==="float"?e.cssFloat="":e[t]="":a?e.setProperty(t,n):typeof n!="number"||n===0||vm.has(t)?t==="float"?e.cssFloat=n:e[t]=(""+n).trim():e[t]=n+"px"}function Xc(e,t,n){if(t!=null&&typeof t!="object")throw Error(y(62));if(e=e.style,n!=null){for(var a in n)!n.hasOwnProperty(a)||t!=null&&t.hasOwnProperty(a)||(a.indexOf("--")===0?e.setProperty(a,""):a==="float"?e.cssFloat="":e[a]="");for(var o in t)a=t[o],t.hasOwnProperty(o)&&n[o]!==a&&ud(e,o,a)}else for(var i in t)t.hasOwnProperty(i)&&ud(e,i,t[i])}function Cl(e){if(e.indexOf("-")===-1)return!1;switch(e){case"annotation-xml":case"color-profile":case"font-face":case"font-face-src":case"font-face-uri":case"font-face-format":case"font-face-name":case"missing-glyph":return!1;default:return!0}}var ym=new Map([["acceptCharset","accept-charset"],["htmlFor","for"],["httpEquiv","http-equiv"],["crossOrigin","crossorigin"],["accentHeight","accent-height"],["alignmentBaseline","alignment-baseline"],["arabicForm","arabic-form"],["baselineShift","baseline-shift"],["capHeight","cap-height"],["clipPath","clip-path"],["clipRule","clip-rule"],["colorInterpolation","color-interpolation"],["colorInterpolationFilters","color-interpolation-filters"],["colorProfile","color-profile"],["colorRendering","color-rendering"],["dominantBaseline","dominant-baseline"],["enableBackground","enable-background"],["fillOpacity","fill-opacity"],["fillRule","fill-rule"],["floodColor","flood-color"],["floodOpacity","flood-opacity"],["fontFamily","font-family"],["fontSize","font-size"],["fontSizeAdjust","font-size-adjust"],["fontStretch","font-stretch"],["fontStyle","font-style"],["fontVariant","font-variant"],["fontWeight","font-weight"],["glyphName","glyph-name"],["glyphOrientationHorizontal","glyph-orientation-horizontal"],["glyphOrientationVertical","glyph-orientation-vertical"],["horizAdvX","horiz-adv-x"],["horizOriginX","horiz-origin-x"],["imageRendering","image-rendering"],["letterSpacing","letter-spacing"],["lightingColor","lighting-color"],["markerEnd","marker-end"],["markerMid","marker-mid"],["markerStart","marker-start"],["overlinePosition","overline-position"],["overlineThickness","overline-thickness"],["paintOrder","paint-order"],["panose-1","panose-1"],["pointerEvents","pointer-events"],["renderingIntent","rendering-intent"],["shapeRendering","shape-rendering"],["stopColor","stop-color"],["stopOpacity","stop-opacity"],["strikethroughPosition","strikethrough-position"],["strikethroughThickness","strikethrough-thickness"],["strokeDasharray","stroke-dasharray"],["strokeDashoffset","stroke-dashoffset"],["strokeLinecap","stroke-linecap"],["strokeLinejoin","stroke-linejoin"],["strokeMiterlimit","stroke-miterlimit"],["strokeOpacity","stroke-opacity"],["strokeWidth","stroke-width"],["textAnchor","text-anchor"],["textDecoration","text-decoration"],["textRendering","text-rendering"],["transformOrigin","transform-origin"],["underlinePosition","underline-position"],["underlineThickness","underline-thickness"],["unicodeBidi","unicode-bidi"],["unicodeRange","unicode-range"],["unitsPerEm","units-per-em"],["vAlphabetic","v-alphabetic"],["vHanging","v-hanging"],["vIdeographic","v-ideographic"],["vMathematical","v-mathematical"],["vectorEffect","vector-effect"],["vertAdvY","vert-adv-y"],["vertOriginX","vert-origin-x"],["vertOriginY","vert-origin-y"],["wordSpacing","word-spacing"],["writingMode","writing-mode"],["xmlnsXlink","xmlns:xlink"],["xHeight","x-height"]]),wm=/^[\u0000-\u001F ]*j[\r\n\t]*a[\r\n\t]*v[\r\n\t]*a[\r\n\t]*s[\r\n\t]*c[\r\n\t]*r[\r\n\t]*i[\r\n\t]*p[\r\n\t]*t[\r\n\t]*:/i;function lr(e){return wm.test(""+e)?"javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')":e}function Tt(){}var Us=null;function Al(e){return e=e.target||e.srcElement||window,e.correspondingUseElement&&(e=e.correspondingUseElement),e.nodeType===3?e.parentNode:e}var Pn=null,oa=null;function dd(e){var t=wa(e);if(t&&(e=t.stateNode)){var n=e[Me]||null;e:switch(e=t.stateNode,t.type){case"input":if(Ns(e,n.value,n.defaultValue,n.defaultValue,n.checked,n.defaultChecked,n.type,n.name),t=n.name,n.type==="radio"&&t!=null){for(n=e;n.parentNode;)n=n.parentNode;for(n=n.querySelectorAll('input[name="'+Ze(""+t)+'"][type="radio"]'),t=0;t<n.length;t++){var a=n[t];if(a!==e&&a.form===e.form){var o=a[Me]||null;if(!o)throw Error(y(90));Ns(a,o.value,o.defaultValue,o.defaultValue,o.checked,o.defaultChecked,o.type,o.name)}}for(t=0;t<n.length;t++)a=n[t],a.form===e.form&&Vc(a)}break e;case"textarea":Kc(e,n.value,n.defaultValue);break e;case"select":t=n.value,t!=null&&aa(e,!!n.multiple,t,!1)}}}var Wi=!1;function Qc(e,t,n){if(Wi)return e(t,n);Wi=!0;try{var a=e(t);return a}finally{if(Wi=!1,(Pn!==null||oa!==null)&&(ui(),Pn&&(t=Pn,e=oa,oa=Pn=null,dd(t),e)))for(t=0;t<e.length;t++)dd(e[t])}}function lo(e,t){var n=e.stateNode;if(n===null)return null;var a=n[Me]||null;if(a===null)return null;n=a[t];e:switch(t){case"onClick":case"onClickCapture":case"onDoubleClick":case"onDoubleClickCapture":case"onMouseDown":case"onMouseDownCapture":case"onMouseMove":case"onMouseMoveCapture":case"onMouseUp":case"onMouseUpCapture":case"onMouseEnter":(a=!a.disabled)||(e=e.type,a=!(e==="button"||e==="input"||e==="select"||e==="textarea")),e=!a;break e;default:e=!1}if(e)return null;if(n&&typeof n!="function")throw Error(y(231,t,typeof n));return n}var Rt=!(typeof window>"u"||typeof window.document>"u"||typeof window.document.createElement>"u"),js=!1;if(Rt)try{jn={},Object.defineProperty(jn,"passive",{get:function(){js=!0}}),window.addEventListener("test",jn,jn),window.removeEventListener("test",jn,jn)}catch{js=!1}var jn,Kt=null,Ol=null,ur=null;function Ic(){if(ur)return ur;var e,t=Ol,n=t.length,a,o="value"in Kt?Kt.value:Kt.textContent,i=o.length;for(e=0;e<n&&t[e]===o[e];e++);var s=n-e;for(a=1;a<=s&&t[n-a]===o[i-a];a++);return ur=o.slice(e,1<a?1-a:void 0)}function dr(e){var t=e.keyCode;return"charCode"in e?(e=e.charCode,e===0&&t===13&&(e=13)):e=t,e===10&&(e=13),32<=e||e===13?e:0}function Xo(){return!0}function cd(){return!1}function Be(e){function t(n,a,o,i,s){this._reactName=n,this._targetInst=o,this.type=a,this.nativeEvent=i,this.target=s,this.currentTarget=null;for(var l in e)e.hasOwnProperty(l)&&(n=e[l],this[l]=n?n(i):i[l]);return this.isDefaultPrevented=(i.defaultPrevented!=null?i.defaultPrevented:i.returnValue===!1)?Xo:cd,this.isPropagationStopped=cd,this}return W(t.prototype,{preventDefault:function(){this.defaultPrevented=!0;var n=this.nativeEvent;n&&(n.preventDefault?n.preventDefault():typeof n.returnValue!="unknown"&&(n.returnValue=!1),this.isDefaultPrevented=Xo)},stopPropagation:function(){var n=this.nativeEvent;n&&(n.stopPropagation?n.stopPropagation():typeof n.cancelBubble!="unknown"&&(n.cancelBubble=!0),this.isPropagationStopped=Xo)},persist:function(){},isPersistent:Xo}),t}var On={eventPhase:0,bubbles:0,cancelable:0,timeStamp:function(e){return e.timeStamp||Date.now()},defaultPrevented:0,isTrusted:0},Wr=Be(On),Co=W({},On,{view:0,detail:0}),Sm=Be(Co),Ji,es,Da,Jr=W({},Co,{screenX:0,screenY:0,clientX:0,clientY:0,pageX:0,pageY:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,getModifierState:Rl,button:0,buttons:0,relatedTarget:function(e){return e.relatedTarget===void 0?e.fromElement===e.srcElement?e.toElement:e.fromElement:e.relatedTarget},movementX:function(e){return"movementX"in e?e.movementX:(e!==Da&&(Da&&e.type==="mousemove"?(Ji=e.screenX-Da.screenX,es=e.screenY-Da.screenY):es=Ji=0,Da=e),Ji)},movementY:function(e){return"movementY"in e?e.movementY:es}}),pd=Be(Jr),km=W({},Jr,{dataTransfer:0}),$m=Be(km),Tm=W({},Co,{relatedTarget:0}),ts=Be(Tm),Em=W({},On,{animationName:0,elapsedTime:0,pseudoElement:0}),Cm=Be(Em),Am=W({},On,{clipboardData:function(e){return"clipboardData"in e?e.clipboardData:window.clipboardData}}),Om=Be(Am),Rm=W({},On,{data:0}),fd=Be(Rm),zm={Esc:"Escape",Spacebar:" ",Left:"ArrowLeft",Up:"ArrowUp",Right:"ArrowRight",Down:"ArrowDown",Del:"Delete",Win:"OS",Menu:"ContextMenu",Apps:"ContextMenu",Scroll:"ScrollLock",MozPrintableKey:"Unidentified"},_m={8:"Backspace",9:"Tab",12:"Clear",13:"Enter",16:"Shift",17:"Control",18:"Alt",19:"Pause",20:"CapsLock",27:"Escape",32:" ",33:"PageUp",34:"PageDown",35:"End",36:"Home",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown",45:"Insert",46:"Delete",112:"F1",113:"F2",114:"F3",115:"F4",116:"F5",117:"F6",118:"F7",119:"F8",120:"F9",121:"F10",122:"F11",123:"F12",144:"NumLock",145:"ScrollLock",224:"Meta"},Mm={Alt:"altKey",Control:"ctrlKey",Meta:"metaKey",Shift:"shiftKey"};function Bm(e){var t=this.nativeEvent;return t.getModifierState?t.getModifierState(e):(e=Mm[e])?!!t[e]:!1}function Rl(){return Bm}var Hm=W({},Co,{key:function(e){if(e.key){var t=zm[e.key]||e.key;if(t!=="Unidentified")return t}return e.type==="keypress"?(e=dr(e),e===13?"Enter":String.fromCharCode(e)):e.type==="keydown"||e.type==="keyup"?_m[e.keyCode]||"Unidentified":""},code:0,location:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,repeat:0,locale:0,getModifierState:Rl,charCode:function(e){return e.type==="keypress"?dr(e):0},keyCode:function(e){return e.type==="keydown"||e.type==="keyup"?e.keyCode:0},which:function(e){return e.type==="keypress"?dr(e):e.type==="keydown"||e.type==="keyup"?e.keyCode:0}}),Nm=Be(Hm),Dm=W({},Jr,{pointerId:0,width:0,height:0,pressure:0,tangentialPressure:0,tiltX:0,tiltY:0,twist:0,pointerType:0,isPrimary:0}),gd=Be(Dm),Um=W({},Co,{touches:0,targetTouches:0,changedTouches:0,altKey:0,metaKey:0,ctrlKey:0,shiftKey:0,getModifierState:Rl}),jm=Be(Um),Lm=W({},On,{propertyName:0,elapsedTime:0,pseudoElement:0}),qm=Be(Lm),Fm=W({},Jr,{deltaX:function(e){return"deltaX"in e?e.deltaX:"wheelDeltaX"in e?-e.wheelDeltaX:0},deltaY:function(e){return"deltaY"in e?e.deltaY:"wheelDeltaY"in e?-e.wheelDeltaY:"wheelDelta"in e?-e.wheelDelta:0},deltaZ:0,deltaMode:0}),Gm=Be(Fm),Vm=W({},On,{newState:0,oldState:0}),Ym=Be(Vm),Km=[9,13,27,32],zl=Rt&&"CompositionEvent"in window,Xa=null;Rt&&"documentMode"in document&&(Xa=document.documentMode);var Pm=Rt&&"TextEvent"in window&&!Xa,Zc=Rt&&(!zl||Xa&&8<Xa&&11>=Xa),hd=" ",md=!1;function Wc(e,t){switch(e){case"keyup":return Km.indexOf(t.keyCode)!==-1;case"keydown":return t.keyCode!==229;case"keypress":case"mousedown":case"focusout":return!0;default:return!1}}function Jc(e){return e=e.detail,typeof e=="object"&&"data"in e?e.data:null}var Xn=!1;function Xm(e,t){switch(e){case"compositionend":return Jc(t);case"keypress":return t.which!==32?null:(md=!0,hd);case"textInput":return e=t.data,e===hd&&md?null:e;default:return null}}function Qm(e,t){if(Xn)return e==="compositionend"||!zl&&Wc(e,t)?(e=Ic(),ur=Ol=Kt=null,Xn=!1,e):null;switch(e){case"paste":return null;case"keypress":if(!(t.ctrlKey||t.altKey||t.metaKey)||t.ctrlKey&&t.altKey){if(t.char&&1<t.char.length)return t.char;if(t.which)return String.fromCharCode(t.which)}return null;case"compositionend":return Zc&&t.locale!=="ko"?null:t.data;default:return null}}var Im={color:!0,date:!0,datetime:!0,"datetime-local":!0,email:!0,month:!0,number:!0,password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0};function bd(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t==="input"?!!Im[e.type]:t==="textarea"}function ep(e,t,n,a){Pn?oa?oa.push(a):oa=[a]:Pn=a,t=Vr(t,"onChange"),0<t.length&&(n=new Wr("onChange","change",null,n,a),e.push({event:n,listeners:t}))}var Qa=null,uo=null;function Zm(e){If(e,0)}function ei(e){var t=Ya(e);if(Vc(t))return e}function xd(e,t){if(e==="change")return t}var tp=!1;Rt&&(Rt?(Io="oninput"in document,Io||(ns=document.createElement("div"),ns.setAttribute("oninput","return;"),Io=typeof ns.oninput=="function"),Qo=Io):Qo=!1,tp=Qo&&(!document.documentMode||9<document.documentMode));var Qo,Io,ns;function vd(){Qa&&(Qa.detachEvent("onpropertychange",np),uo=Qa=null)}function np(e){if(e.propertyName==="value"&&ei(uo)){var t=[];ep(t,uo,e,Al(e)),Qc(Zm,t)}}function Wm(e,t,n){e==="focusin"?(vd(),Qa=t,uo=n,Qa.attachEvent("onpropertychange",np)):e==="focusout"&&vd()}function Jm(e){if(e==="selectionchange"||e==="keyup"||e==="keydown")return ei(uo)}function eb(e,t){if(e==="click")return ei(t)}function tb(e,t){if(e==="input"||e==="change")return ei(t)}function nb(e,t){return e===t&&(e!==0||1/e===1/t)||e!==e&&t!==t}var Ge=typeof Object.is=="function"?Object.is:nb;function co(e,t){if(Ge(e,t))return!0;if(typeof e!="object"||e===null||typeof t!="object"||t===null)return!1;var n=Object.keys(e),a=Object.keys(t);if(n.length!==a.length)return!1;for(a=0;a<n.length;a++){var o=n[a];if(!Ms.call(t,o)||!Ge(e[o],t[o]))return!1}return!0}function yd(e){for(;e&&e.firstChild;)e=e.firstChild;return e}function wd(e,t){var n=yd(e);e=0;for(var a;n;){if(n.nodeType===3){if(a=e+n.textContent.length,e<=t&&a>=t)return{node:n,offset:t-e};e=a}e:{for(;n;){if(n.nextSibling){n=n.nextSibling;break e}n=n.parentNode}n=void 0}n=yd(n)}}function ap(e,t){return e&&t?e===t?!0:e&&e.nodeType===3?!1:t&&t.nodeType===3?ap(e,t.parentNode):"contains"in e?e.contains(t):e.compareDocumentPosition?!!(e.compareDocumentPosition(t)&16):!1:!1}function op(e){e=e!=null&&e.ownerDocument!=null&&e.ownerDocument.defaultView!=null?e.ownerDocument.defaultView:window;for(var t=Er(e.document);t instanceof e.HTMLIFrameElement;){try{var n=typeof t.contentWindow.location.href=="string"}catch{n=!1}if(n)e=t.contentWindow;else break;t=Er(e.document)}return t}function _l(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t&&(t==="input"&&(e.type==="text"||e.type==="search"||e.type==="tel"||e.type==="url"||e.type==="password")||t==="textarea"||e.contentEditable==="true")}var ab=Rt&&"documentMode"in document&&11>=document.documentMode,Qn=null,Ls=null,Ia=null,qs=!1;function Sd(e,t,n){var a=n.window===n?n.document:n.nodeType===9?n:n.ownerDocument;qs||Qn==null||Qn!==Er(a)||(a=Qn,"selectionStart"in a&&_l(a)?a={start:a.selectionStart,end:a.selectionEnd}:(a=(a.ownerDocument&&a.ownerDocument.defaultView||window).getSelection(),a={anchorNode:a.anchorNode,anchorOffset:a.anchorOffset,focusNode:a.focusNode,focusOffset:a.focusOffset}),Ia&&co(Ia,a)||(Ia=a,a=Vr(Ls,"onSelect"),0<a.length&&(t=new Wr("onSelect","select",null,t,n),e.push({event:t,listeners:a}),t.target=Qn)))}function fn(e,t){var n={};return n[e.toLowerCase()]=t.toLowerCase(),n["Webkit"+e]="webkit"+t,n["Moz"+e]="moz"+t,n}var In={animationend:fn("Animation","AnimationEnd"),animationiteration:fn("Animation","AnimationIteration"),animationstart:fn("Animation","AnimationStart"),transitionrun:fn("Transition","TransitionRun"),transitionstart:fn("Transition","TransitionStart"),transitioncancel:fn("Transition","TransitionCancel"),transitionend:fn("Transition","TransitionEnd")},as={},rp={};Rt&&(rp=document.createElement("div").style,"AnimationEvent"in window||(delete In.animationend.animation,delete In.animationiteration.animation,delete In.animationstart.animation),"TransitionEvent"in window||delete In.transitionend.transition);function Rn(e){if(as[e])return as[e];if(!In[e])return e;var t=In[e],n;for(n in t)if(t.hasOwnProperty(n)&&n in rp)return as[e]=t[n];return e}var ip=Rn("animationend"),sp=Rn("animationiteration"),lp=Rn("animationstart"),ob=Rn("transitionrun"),rb=Rn("transitionstart"),ib=Rn("transitioncancel"),up=Rn("transitionend"),dp=new Map,Fs="abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");Fs.push("scrollEnd");function it(e,t){dp.set(e,t),An(t,[e])}var Cr=typeof reportError=="function"?reportError:function(e){if(typeof window=="object"&&typeof window.ErrorEvent=="function"){var t=new window.ErrorEvent("error",{bubbles:!0,cancelable:!0,message:typeof e=="object"&&e!==null&&typeof e.message=="string"?String(e.message):String(e),error:e});if(!window.dispatchEvent(t))return}else if(typeof process=="object"&&typeof process.emit=="function"){process.emit("uncaughtException",e);return}console.error(e)},Pe=[],Zn=0,Ml=0;function ti(){for(var e=Zn,t=Ml=Zn=0;t<e;){var n=Pe[t];Pe[t++]=null;var a=Pe[t];Pe[t++]=null;var o=Pe[t];Pe[t++]=null;var i=Pe[t];if(Pe[t++]=null,a!==null&&o!==null){var s=a.pending;s===null?o.next=o:(o.next=s.next,s.next=o),a.pending=o}i!==0&&cp(n,o,i)}}function ni(e,t,n,a){Pe[Zn++]=e,Pe[Zn++]=t,Pe[Zn++]=n,Pe[Zn++]=a,Ml|=a,e.lanes|=a,e=e.alternate,e!==null&&(e.lanes|=a)}function Bl(e,t,n,a){return ni(e,t,n,a),Ar(e)}function zn(e,t){return ni(e,null,null,t),Ar(e)}function cp(e,t,n){e.lanes|=n;var a=e.alternate;a!==null&&(a.lanes|=n);for(var o=!1,i=e.return;i!==null;)i.childLanes|=n,a=i.alternate,a!==null&&(a.childLanes|=n),i.tag===22&&(e=i.stateNode,e===null||e._visibility&1||(o=!0)),e=i,i=i.return;return e.tag===3?(i=e.stateNode,o&&t!==null&&(o=31-qe(n),e=i.hiddenUpdates,a=e[o],a===null?e[o]=[t]:a.push(t),t.lane=n|536870912),i):null}function Ar(e){if(50<ro)throw ro=0,ul=null,Error(y(185));for(var t=e.return;t!==null;)e=t,t=e.return;return e.tag===3?e.stateNode:null}var Wn={};function sb(e,t,n,a){this.tag=e,this.key=n,this.sibling=this.child=this.return=this.stateNode=this.type=this.elementType=null,this.index=0,this.refCleanup=this.ref=null,this.pendingProps=t,this.dependencies=this.memoizedState=this.updateQueue=this.memoizedProps=null,this.mode=a,this.subtreeFlags=this.flags=0,this.deletions=null,this.childLanes=this.lanes=0,this.alternate=null}function De(e,t,n,a){return new sb(e,t,n,a)}function Hl(e){return e=e.prototype,!(!e||!e.isReactComponent)}function Ct(e,t){var n=e.alternate;return n===null?(n=De(e.tag,t,e.key,e.mode),n.elementType=e.elementType,n.type=e.type,n.stateNode=e.stateNode,n.alternate=e,e.alternate=n):(n.pendingProps=t,n.type=e.type,n.flags=0,n.subtreeFlags=0,n.deletions=null),n.flags=e.flags&65011712,n.childLanes=e.childLanes,n.lanes=e.lanes,n.child=e.child,n.memoizedProps=e.memoizedProps,n.memoizedState=e.memoizedState,n.updateQueue=e.updateQueue,t=e.dependencies,n.dependencies=t===null?null:{lanes:t.lanes,firstContext:t.firstContext},n.sibling=e.sibling,n.index=e.index,n.ref=e.ref,n.refCleanup=e.refCleanup,n}function pp(e,t){e.flags&=65011714;var n=e.alternate;return n===null?(e.childLanes=0,e.lanes=t,e.child=null,e.subtreeFlags=0,e.memoizedProps=null,e.memoizedState=null,e.updateQueue=null,e.dependencies=null,e.stateNode=null):(e.childLanes=n.childLanes,e.lanes=n.lanes,e.child=n.child,e.subtreeFlags=0,e.deletions=null,e.memoizedProps=n.memoizedProps,e.memoizedState=n.memoizedState,e.updateQueue=n.updateQueue,e.type=n.type,t=n.dependencies,e.dependencies=t===null?null:{lanes:t.lanes,firstContext:t.firstContext}),e}function cr(e,t,n,a,o,i){var s=0;if(a=e,typeof e=="function")Hl(e)&&(s=1);else if(typeof e=="string")s=dx(e,n,ct.current)?26:e==="html"||e==="head"||e==="body"?27:5;else e:switch(e){case Os:return e=De(31,n,t,o),e.elementType=Os,e.lanes=i,e;case Vn:return vn(n.children,o,i,t);case zc:s=8,o|=24;break;case Es:return e=De(12,n,t,o|2),e.elementType=Es,e.lanes=i,e;case Cs:return e=De(13,n,t,o),e.elementType=Cs,e.lanes=i,e;case As:return e=De(19,n,t,o),e.elementType=As,e.lanes=i,e;default:if(typeof e=="object"&&e!==null)switch(e.$$typeof){case $t:s=10;break e;case _c:s=9;break e;case wl:s=11;break e;case Sl:s=14;break e;case jt:s=16,a=null;break e}s=29,n=Error(y(130,e===null?"null":typeof e,"")),a=null}return t=De(s,n,t,o),t.elementType=e,t.type=a,t.lanes=i,t}function vn(e,t,n,a){return e=De(7,e,a,t),e.lanes=n,e}function os(e,t,n){return e=De(6,e,null,t),e.lanes=n,e}function fp(e){var t=De(18,null,null,0);return t.stateNode=e,t}function rs(e,t,n){return t=De(4,e.children!==null?e.children:[],e.key,t),t.lanes=n,t.stateNode={containerInfo:e.containerInfo,pendingChildren:null,implementation:e.implementation},t}var kd=new WeakMap;function We(e,t){if(typeof e=="object"&&e!==null){var n=kd.get(e);return n!==void 0?n:(t={value:e,source:t,stack:od(t)},kd.set(e,t),t)}return{value:e,source:t,stack:od(t)}}var Jn=[],ea=0,Or=null,po=0,Qe=[],Ie=0,rn=null,lt=1,ut="";function St(e,t){Jn[ea++]=po,Jn[ea++]=Or,Or=e,po=t}function gp(e,t,n){Qe[Ie++]=lt,Qe[Ie++]=ut,Qe[Ie++]=rn,rn=e;var a=lt;e=ut;var o=32-qe(a)-1;a&=~(1<<o),n+=1;var i=32-qe(t)+o;if(30<i){var s=o-o%5;i=(a&(1<<s)-1).toString(32),a>>=s,o-=s,lt=1<<32-qe(t)+o|n<<o|a,ut=i+e}else lt=1<<i|n<<o|a,ut=e}function Nl(e){e.return!==null&&(St(e,1),gp(e,1,0))}function Dl(e){for(;e===Or;)Or=Jn[--ea],Jn[ea]=null,po=Jn[--ea],Jn[ea]=null;for(;e===rn;)rn=Qe[--Ie],Qe[Ie]=null,ut=Qe[--Ie],Qe[Ie]=null,lt=Qe[--Ie],Qe[Ie]=null}function hp(e,t){Qe[Ie++]=lt,Qe[Ie++]=ut,Qe[Ie++]=rn,lt=t.id,ut=t.overflow,rn=e}var xe=null,Z=null,M=!1,Zt=null,Je=!1,Gs=Error(y(519));function sn(e){var t=Error(y(418,1<arguments.length&&arguments[1]!==void 0&&arguments[1]?"text":"HTML",""));throw fo(We(t,e)),Gs}function $d(e){var t=e.stateNode,n=e.type,a=e.memoizedProps;switch(t[be]=e,t[Me]=a,n){case"dialog":O("cancel",t),O("close",t);break;case"iframe":case"object":case"embed":O("load",t);break;case"video":case"audio":for(n=0;n<bo.length;n++)O(bo[n],t);break;case"source":O("error",t);break;case"img":case"image":case"link":O("error",t),O("load",t);break;case"details":O("toggle",t);break;case"input":O("invalid",t),Yc(t,a.value,a.defaultValue,a.checked,a.defaultChecked,a.type,a.name,!0);break;case"select":O("invalid",t);break;case"textarea":O("invalid",t),Pc(t,a.value,a.defaultValue,a.children)}n=a.children,typeof n!="string"&&typeof n!="number"&&typeof n!="bigint"||t.textContent===""+n||a.suppressHydrationWarning===!0||Wf(t.textContent,n)?(a.popover!=null&&(O("beforetoggle",t),O("toggle",t)),a.onScroll!=null&&O("scroll",t),a.onScrollEnd!=null&&O("scrollend",t),a.onClick!=null&&(t.onclick=Tt),t=!0):t=!1,t||sn(e,!0)}function Td(e){for(xe=e.return;xe;)switch(xe.tag){case 5:case 31:case 13:Je=!1;return;case 27:case 3:Je=!0;return;default:xe=xe.return}}function Ln(e){if(e!==xe)return!1;if(!M)return Td(e),M=!0,!1;var t=e.tag,n;if((n=t!==3&&t!==27)&&((n=t===5)&&(n=e.type,n=!(n!=="form"&&n!=="button")||gl(e.type,e.memoizedProps)),n=!n),n&&Z&&sn(e),Td(e),t===13){if(e=e.memoizedState,e=e!==null?e.dehydrated:null,!e)throw Error(y(317));Z=fc(e)}else if(t===31){if(e=e.memoizedState,e=e!==null?e.dehydrated:null,!e)throw Error(y(317));Z=fc(e)}else t===27?(t=Z,cn(e.type)?(e=xl,xl=null,Z=e):Z=t):Z=xe?tt(e.stateNode.nextSibling):null;return!0}function kn(){Z=xe=null,M=!1}function is(){var e=Zt;return e!==null&&(ze===null?ze=e:ze.push.apply(ze,e),Zt=null),e}function fo(e){Zt===null?Zt=[e]:Zt.push(e)}var Vs=pt(null),_n=null,Et=null;function qt(e,t,n){K(Vs,t._currentValue),t._currentValue=n}function At(e){e._currentValue=Vs.current,ge(Vs)}function Ys(e,t,n){for(;e!==null;){var a=e.alternate;if((e.childLanes&t)!==t?(e.childLanes|=t,a!==null&&(a.childLanes|=t)):a!==null&&(a.childLanes&t)!==t&&(a.childLanes|=t),e===n)break;e=e.return}}function Ks(e,t,n,a){var o=e.child;for(o!==null&&(o.return=e);o!==null;){var i=o.dependencies;if(i!==null){var s=o.child;i=i.firstContext;e:for(;i!==null;){var l=i;i=o;for(var u=0;u<t.length;u++)if(l.context===t[u]){i.lanes|=n,l=i.alternate,l!==null&&(l.lanes|=n),Ys(i.return,n,e),a||(s=null);break e}i=l.next}}else if(o.tag===18){if(s=o.return,s===null)throw Error(y(341));s.lanes|=n,i=s.alternate,i!==null&&(i.lanes|=n),Ys(s,n,e),s=null}else s=o.child;if(s!==null)s.return=o;else for(s=o;s!==null;){if(s===e){s=null;break}if(o=s.sibling,o!==null){o.return=s.return,s=o;break}s=s.return}o=s}}function Sa(e,t,n,a){e=null;for(var o=t,i=!1;o!==null;){if(!i){if((o.flags&524288)!==0)i=!0;else if((o.flags&262144)!==0)break}if(o.tag===10){var s=o.alternate;if(s===null)throw Error(y(387));if(s=s.memoizedProps,s!==null){var l=o.type;Ge(o.pendingProps.value,s.value)||(e!==null?e.push(l):e=[l])}}else if(o===Sr.current){if(s=o.alternate,s===null)throw Error(y(387));s.memoizedState.memoizedState!==o.memoizedState.memoizedState&&(e!==null?e.push(vo):e=[vo])}o=o.return}e!==null&&Ks(t,e,n,a),t.flags|=262144}function Rr(e){for(e=e.firstContext;e!==null;){if(!Ge(e.context._currentValue,e.memoizedValue))return!0;e=e.next}return!1}function $n(e){_n=e,Et=null,e=e.dependencies,e!==null&&(e.firstContext=null)}function ve(e){return mp(_n,e)}function Zo(e,t){return _n===null&&$n(e),mp(e,t)}function mp(e,t){var n=t._currentValue;if(t={context:t,memoizedValue:n,next:null},Et===null){if(e===null)throw Error(y(308));Et=t,e.dependencies={lanes:0,firstContext:t},e.flags|=524288}else Et=Et.next=t;return n}var lb=typeof AbortController<"u"?AbortController:function(){var e=[],t=this.signal={aborted:!1,addEventListener:function(n,a){e.push(a)}};this.abort=function(){t.aborted=!0,e.forEach(function(n){return n()})}},ub=ce.unstable_scheduleCallback,db=ce.unstable_NormalPriority,le={$$typeof:$t,Consumer:null,Provider:null,_currentValue:null,_currentValue2:null,_threadCount:0};function Ul(){return{controller:new lb,data:new Map,refCount:0}}function Ao(e){e.refCount--,e.refCount===0&&ub(db,function(){e.controller.abort()})}var Za=null,Ps=0,pa=0,ra=null;function cb(e,t){if(Za===null){var n=Za=[];Ps=0,pa=uu(),ra={status:"pending",value:void 0,then:function(a){n.push(a)}}}return Ps++,t.then(Ed,Ed),t}function Ed(){if(--Ps===0&&Za!==null){ra!==null&&(ra.status="fulfilled");var e=Za;Za=null,pa=0,ra=null;for(var t=0;t<e.length;t++)(0,e[t])()}}function pb(e,t){var n=[],a={status:"pending",value:null,reason:null,then:function(o){n.push(o)}};return e.then(function(){a.status="fulfilled",a.value=t;for(var o=0;o<n.length;o++)(0,n[o])(t)},function(o){for(a.status="rejected",a.reason=o,o=0;o<n.length;o++)(0,n[o])(void 0)}),a}var Cd=T.S;T.S=function(e,t){zf=je(),typeof t=="object"&&t!==null&&typeof t.then=="function"&&cb(e,t),Cd!==null&&Cd(e,t)};var yn=pt(null);function jl(){var e=yn.current;return e!==null?e:V.pooledCache}function pr(e,t){t===null?K(yn,yn.current):K(yn,t.pool)}function bp(){var e=jl();return e===null?null:{parent:le._currentValue,pool:e}}var ka=Error(y(460)),Ll=Error(y(474)),ai=Error(y(542)),zr={then:function(){}};function Ad(e){return e=e.status,e==="fulfilled"||e==="rejected"}function xp(e,t,n){switch(n=e[n],n===void 0?e.push(t):n!==t&&(t.then(Tt,Tt),t=n),t.status){case"fulfilled":return t.value;case"rejected":throw e=t.reason,Rd(e),e;default:if(typeof t.status=="string")t.then(Tt,Tt);else{if(e=V,e!==null&&100<e.shellSuspendCounter)throw Error(y(482));e=t,e.status="pending",e.then(function(a){if(t.status==="pending"){var o=t;o.status="fulfilled",o.value=a}},function(a){if(t.status==="pending"){var o=t;o.status="rejected",o.reason=a}})}switch(t.status){case"fulfilled":return t.value;case"rejected":throw e=t.reason,Rd(e),e}throw wn=t,ka}}function mn(e){try{var t=e._init;return t(e._payload)}catch(n){throw n!==null&&typeof n=="object"&&typeof n.then=="function"?(wn=n,ka):n}}var wn=null;function Od(){if(wn===null)throw Error(y(459));var e=wn;return wn=null,e}function Rd(e){if(e===ka||e===ai)throw Error(y(483))}var ia=null,go=0;function Wo(e){var t=go;return go+=1,ia===null&&(ia=[]),xp(ia,e,t)}function Ua(e,t){t=t.props.ref,e.ref=t!==void 0?t:null}function Jo(e,t){throw t.$$typeof===Wh?Error(y(525)):(e=Object.prototype.toString.call(t),Error(y(31,e==="[object Object]"?"object with keys {"+Object.keys(t).join(", ")+"}":e)))}function vp(e){function t(p,d){if(e){var g=p.deletions;g===null?(p.deletions=[d],p.flags|=16):g.push(d)}}function n(p,d){if(!e)return null;for(;d!==null;)t(p,d),d=d.sibling;return null}function a(p){for(var d=new Map;p!==null;)p.key!==null?d.set(p.key,p):d.set(p.index,p),p=p.sibling;return d}function o(p,d){return p=Ct(p,d),p.index=0,p.sibling=null,p}function i(p,d,g){return p.index=g,e?(g=p.alternate,g!==null?(g=g.index,g<d?(p.flags|=67108866,d):g):(p.flags|=67108866,d)):(p.flags|=1048576,d)}function s(p){return e&&p.alternate===null&&(p.flags|=67108866),p}function l(p,d,g,v){return d===null||d.tag!==6?(d=os(g,p.mode,v),d.return=p,d):(d=o(d,g),d.return=p,d)}function u(p,d,g,v){var k=g.type;return k===Vn?m(p,d,g.props.children,v,g.key):d!==null&&(d.elementType===k||typeof k=="object"&&k!==null&&k.$$typeof===jt&&mn(k)===d.type)?(d=o(d,g.props),Ua(d,g),d.return=p,d):(d=cr(g.type,g.key,g.props,null,p.mode,v),Ua(d,g),d.return=p,d)}function c(p,d,g,v){return d===null||d.tag!==4||d.stateNode.containerInfo!==g.containerInfo||d.stateNode.implementation!==g.implementation?(d=rs(g,p.mode,v),d.return=p,d):(d=o(d,g.children||[]),d.return=p,d)}function m(p,d,g,v,k){return d===null||d.tag!==7?(d=vn(g,p.mode,v,k),d.return=p,d):(d=o(d,g),d.return=p,d)}function b(p,d,g){if(typeof d=="string"&&d!==""||typeof d=="number"||typeof d=="bigint")return d=os(""+d,p.mode,g),d.return=p,d;if(typeof d=="object"&&d!==null){switch(d.$$typeof){case Go:return g=cr(d.type,d.key,d.props,null,p.mode,g),Ua(g,d),g.return=p,g;case Ga:return d=rs(d,p.mode,g),d.return=p,d;case jt:return d=mn(d),b(p,d,g)}if(Va(d)||Na(d))return d=vn(d,p.mode,g,null),d.return=p,d;if(typeof d.then=="function")return b(p,Wo(d),g);if(d.$$typeof===$t)return b(p,Zo(p,d),g);Jo(p,d)}return null}function f(p,d,g,v){var k=d!==null?d.key:null;if(typeof g=="string"&&g!==""||typeof g=="number"||typeof g=="bigint")return k!==null?null:l(p,d,""+g,v);if(typeof g=="object"&&g!==null){switch(g.$$typeof){case Go:return g.key===k?u(p,d,g,v):null;case Ga:return g.key===k?c(p,d,g,v):null;case jt:return g=mn(g),f(p,d,g,v)}if(Va(g)||Na(g))return k!==null?null:m(p,d,g,v,null);if(typeof g.then=="function")return f(p,d,Wo(g),v);if(g.$$typeof===$t)return f(p,d,Zo(p,g),v);Jo(p,g)}return null}function h(p,d,g,v,k){if(typeof v=="string"&&v!==""||typeof v=="number"||typeof v=="bigint")return p=p.get(g)||null,l(d,p,""+v,k);if(typeof v=="object"&&v!==null){switch(v.$$typeof){case Go:return p=p.get(v.key===null?g:v.key)||null,u(d,p,v,k);case Ga:return p=p.get(v.key===null?g:v.key)||null,c(d,p,v,k);case jt:return v=mn(v),h(p,d,g,v,k)}if(Va(v)||Na(v))return p=p.get(g)||null,m(d,p,v,k,null);if(typeof v.then=="function")return h(p,d,g,Wo(v),k);if(v.$$typeof===$t)return h(p,d,g,Zo(d,v),k);Jo(d,v)}return null}function w(p,d,g,v){for(var k=null,H=null,S=d,A=d=0,z=null;S!==null&&A<g.length;A++){S.index>A?(z=S,S=null):z=S.sibling;var N=f(p,S,g[A],v);if(N===null){S===null&&(S=z);break}e&&S&&N.alternate===null&&t(p,S),d=i(N,d,A),H===null?k=N:H.sibling=N,H=N,S=z}if(A===g.length)return n(p,S),M&&St(p,A),k;if(S===null){for(;A<g.length;A++)S=b(p,g[A],v),S!==null&&(d=i(S,d,A),H===null?k=S:H.sibling=S,H=S);return M&&St(p,A),k}for(S=a(S);A<g.length;A++)z=h(S,p,A,g[A],v),z!==null&&(e&&z.alternate!==null&&S.delete(z.key===null?A:z.key),d=i(z,d,A),H===null?k=z:H.sibling=z,H=z);return e&&S.forEach(function(Nt){return t(p,Nt)}),M&&St(p,A),k}function $(p,d,g,v){if(g==null)throw Error(y(151));for(var k=null,H=null,S=d,A=d=0,z=null,N=g.next();S!==null&&!N.done;A++,N=g.next()){S.index>A?(z=S,S=null):z=S.sibling;var Nt=f(p,S,N.value,v);if(Nt===null){S===null&&(S=z);break}e&&S&&Nt.alternate===null&&t(p,S),d=i(Nt,d,A),H===null?k=Nt:H.sibling=Nt,H=Nt,S=z}if(N.done)return n(p,S),M&&St(p,A),k;if(S===null){for(;!N.done;A++,N=g.next())N=b(p,N.value,v),N!==null&&(d=i(N,d,A),H===null?k=N:H.sibling=N,H=N);return M&&St(p,A),k}for(S=a(S);!N.done;A++,N=g.next())N=h(S,p,A,N.value,v),N!==null&&(e&&N.alternate!==null&&S.delete(N.key===null?A:N.key),d=i(N,d,A),H===null?k=N:H.sibling=N,H=N);return e&&S.forEach(function(Sh){return t(p,Sh)}),M&&St(p,A),k}function B(p,d,g,v){if(typeof g=="object"&&g!==null&&g.type===Vn&&g.key===null&&(g=g.props.children),typeof g=="object"&&g!==null){switch(g.$$typeof){case Go:e:{for(var k=g.key;d!==null;){if(d.key===k){if(k=g.type,k===Vn){if(d.tag===7){n(p,d.sibling),v=o(d,g.props.children),v.return=p,p=v;break e}}else if(d.elementType===k||typeof k=="object"&&k!==null&&k.$$typeof===jt&&mn(k)===d.type){n(p,d.sibling),v=o(d,g.props),Ua(v,g),v.return=p,p=v;break e}n(p,d);break}else t(p,d);d=d.sibling}g.type===Vn?(v=vn(g.props.children,p.mode,v,g.key),v.return=p,p=v):(v=cr(g.type,g.key,g.props,null,p.mode,v),Ua(v,g),v.return=p,p=v)}return s(p);case Ga:e:{for(k=g.key;d!==null;){if(d.key===k)if(d.tag===4&&d.stateNode.containerInfo===g.containerInfo&&d.stateNode.implementation===g.implementation){n(p,d.sibling),v=o(d,g.children||[]),v.return=p,p=v;break e}else{n(p,d);break}else t(p,d);d=d.sibling}v=rs(g,p.mode,v),v.return=p,p=v}return s(p);case jt:return g=mn(g),B(p,d,g,v)}if(Va(g))return w(p,d,g,v);if(Na(g)){if(k=Na(g),typeof k!="function")throw Error(y(150));return g=k.call(g),$(p,d,g,v)}if(typeof g.then=="function")return B(p,d,Wo(g),v);if(g.$$typeof===$t)return B(p,d,Zo(p,g),v);Jo(p,g)}return typeof g=="string"&&g!==""||typeof g=="number"||typeof g=="bigint"?(g=""+g,d!==null&&d.tag===6?(n(p,d.sibling),v=o(d,g),v.return=p,p=v):(n(p,d),v=os(g,p.mode,v),v.return=p,p=v),s(p)):n(p,d)}return function(p,d,g,v){try{go=0;var k=B(p,d,g,v);return ia=null,k}catch(S){if(S===ka||S===ai)throw S;var H=De(29,S,null,p.mode);return H.lanes=v,H.return=p,H}}}var Tn=vp(!0),yp=vp(!1),Lt=!1;function ql(e){e.updateQueue={baseState:e.memoizedState,firstBaseUpdate:null,lastBaseUpdate:null,shared:{pending:null,lanes:0,hiddenCallbacks:null},callbacks:null}}function Xs(e,t){e=e.updateQueue,t.updateQueue===e&&(t.updateQueue={baseState:e.baseState,firstBaseUpdate:e.firstBaseUpdate,lastBaseUpdate:e.lastBaseUpdate,shared:e.shared,callbacks:null})}function Wt(e){return{lane:e,tag:0,payload:null,callback:null,next:null}}function Jt(e,t,n){var a=e.updateQueue;if(a===null)return null;if(a=a.shared,(D&2)!==0){var o=a.pending;return o===null?t.next=t:(t.next=o.next,o.next=t),a.pending=t,t=Ar(e),cp(e,null,n),t}return ni(e,a,t,n),Ar(e)}function Wa(e,t,n){if(t=t.updateQueue,t!==null&&(t=t.shared,(n&4194048)!==0)){var a=t.lanes;a&=e.pendingLanes,n|=a,t.lanes=n,Uc(e,n)}}function ss(e,t){var n=e.updateQueue,a=e.alternate;if(a!==null&&(a=a.updateQueue,n===a)){var o=null,i=null;if(n=n.firstBaseUpdate,n!==null){do{var s={lane:n.lane,tag:n.tag,payload:n.payload,callback:null,next:null};i===null?o=i=s:i=i.next=s,n=n.next}while(n!==null);i===null?o=i=t:i=i.next=t}else o=i=t;n={baseState:a.baseState,firstBaseUpdate:o,lastBaseUpdate:i,shared:a.shared,callbacks:a.callbacks},e.updateQueue=n;return}e=n.lastBaseUpdate,e===null?n.firstBaseUpdate=t:e.next=t,n.lastBaseUpdate=t}var Qs=!1;function Ja(){if(Qs){var e=ra;if(e!==null)throw e}}function eo(e,t,n,a){Qs=!1;var o=e.updateQueue;Lt=!1;var i=o.firstBaseUpdate,s=o.lastBaseUpdate,l=o.shared.pending;if(l!==null){o.shared.pending=null;var u=l,c=u.next;u.next=null,s===null?i=c:s.next=c,s=u;var m=e.alternate;m!==null&&(m=m.updateQueue,l=m.lastBaseUpdate,l!==s&&(l===null?m.firstBaseUpdate=c:l.next=c,m.lastBaseUpdate=u))}if(i!==null){var b=o.baseState;s=0,m=c=u=null,l=i;do{var f=l.lane&-536870913,h=f!==l.lane;if(h?(_&f)===f:(a&f)===f){f!==0&&f===pa&&(Qs=!0),m!==null&&(m=m.next={lane:0,tag:l.tag,payload:l.payload,callback:null,next:null});e:{var w=e,$=l;f=t;var B=n;switch($.tag){case 1:if(w=$.payload,typeof w=="function"){b=w.call(B,b,f);break e}b=w;break e;case 3:w.flags=w.flags&-65537|128;case 0:if(w=$.payload,f=typeof w=="function"?w.call(B,b,f):w,f==null)break e;b=W({},b,f);break e;case 2:Lt=!0}}f=l.callback,f!==null&&(e.flags|=64,h&&(e.flags|=8192),h=o.callbacks,h===null?o.callbacks=[f]:h.push(f))}else h={lane:f,tag:l.tag,payload:l.payload,callback:l.callback,next:null},m===null?(c=m=h,u=b):m=m.next=h,s|=f;if(l=l.next,l===null){if(l=o.shared.pending,l===null)break;h=l,l=h.next,h.next=null,o.lastBaseUpdate=h,o.shared.pending=null}}while(!0);m===null&&(u=b),o.baseState=u,o.firstBaseUpdate=c,o.lastBaseUpdate=m,i===null&&(o.shared.lanes=0),un|=s,e.lanes=s,e.memoizedState=b}}function wp(e,t){if(typeof e!="function")throw Error(y(191,e));e.call(t)}function Sp(e,t){var n=e.callbacks;if(n!==null)for(e.callbacks=null,e=0;e<n.length;e++)wp(n[e],t)}var fa=pt(null),_r=pt(0);function zd(e,t){e=Bt,K(_r,e),K(fa,t),Bt=e|t.baseLanes}function Is(){K(_r,Bt),K(fa,fa.current)}function Fl(){Bt=_r.current,ge(fa),ge(_r)}var Ve=pt(null),et=null;function Ft(e){var t=e.alternate;K(ae,ae.current&1),K(Ve,e),et===null&&(t===null||fa.current!==null||t.memoizedState!==null)&&(et=e)}function Zs(e){K(ae,ae.current),K(Ve,e),et===null&&(et=e)}function kp(e){e.tag===22?(K(ae,ae.current),K(Ve,e),et===null&&(et=e)):Gt(e)}function Gt(){K(ae,ae.current),K(Ve,Ve.current)}function Ne(e){ge(Ve),et===e&&(et=null),ge(ae)}var ae=pt(0);function Mr(e){for(var t=e;t!==null;){if(t.tag===13){var n=t.memoizedState;if(n!==null&&(n=n.dehydrated,n===null||ml(n)||bl(n)))return t}else if(t.tag===19&&(t.memoizedProps.revealOrder==="forwards"||t.memoizedProps.revealOrder==="backwards"||t.memoizedProps.revealOrder==="unstable_legacy-backwards"||t.memoizedProps.revealOrder==="together")){if((t.flags&128)!==0)return t}else if(t.child!==null){t.child.return=t,t=t.child;continue}if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return null;t=t.return}t.sibling.return=t.return,t=t.sibling}return null}var zt=0,C=null,G=null,ie=null,Br=!1,sa=!1,En=!1,Hr=0,ho=0,la=null,fb=0;function te(){throw Error(y(321))}function Gl(e,t){if(t===null)return!1;for(var n=0;n<t.length&&n<e.length;n++)if(!Ge(e[n],t[n]))return!1;return!0}function Vl(e,t,n,a,o,i){return zt=i,C=t,t.memoizedState=null,t.updateQueue=null,t.lanes=0,T.H=e===null||e.memoizedState===null?ef:tu,En=!1,i=n(a,o),En=!1,sa&&(i=Tp(t,n,a,o)),$p(e),i}function $p(e){T.H=mo;var t=G!==null&&G.next!==null;if(zt=0,ie=G=C=null,Br=!1,ho=0,la=null,t)throw Error(y(300));e===null||ue||(e=e.dependencies,e!==null&&Rr(e)&&(ue=!0))}function Tp(e,t,n,a){C=e;var o=0;do{if(sa&&(la=null),ho=0,sa=!1,25<=o)throw Error(y(301));if(o+=1,ie=G=null,e.updateQueue!=null){var i=e.updateQueue;i.lastEffect=null,i.events=null,i.stores=null,i.memoCache!=null&&(i.memoCache.index=0)}T.H=tf,i=t(n,a)}while(sa);return i}function gb(){var e=T.H,t=e.useState()[0];return t=typeof t.then=="function"?Oo(t):t,e=e.useState()[0],(G!==null?G.memoizedState:null)!==e&&(C.flags|=1024),t}function Yl(){var e=Hr!==0;return Hr=0,e}function Kl(e,t,n){t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~n}function Pl(e){if(Br){for(e=e.memoizedState;e!==null;){var t=e.queue;t!==null&&(t.pending=null),e=e.next}Br=!1}zt=0,ie=G=C=null,sa=!1,ho=Hr=0,la=null}function Ee(){var e={memoizedState:null,baseState:null,baseQueue:null,queue:null,next:null};return ie===null?C.memoizedState=ie=e:ie=ie.next=e,ie}function oe(){if(G===null){var e=C.alternate;e=e!==null?e.memoizedState:null}else e=G.next;var t=ie===null?C.memoizedState:ie.next;if(t!==null)ie=t,G=e;else{if(e===null)throw C.alternate===null?Error(y(467)):Error(y(310));G=e,e={memoizedState:G.memoizedState,baseState:G.baseState,baseQueue:G.baseQueue,queue:G.queue,next:null},ie===null?C.memoizedState=ie=e:ie=ie.next=e}return ie}function oi(){return{lastEffect:null,events:null,stores:null,memoCache:null}}function Oo(e){var t=ho;return ho+=1,la===null&&(la=[]),e=xp(la,e,t),t=C,(ie===null?t.memoizedState:ie.next)===null&&(t=t.alternate,T.H=t===null||t.memoizedState===null?ef:tu),e}function ri(e){if(e!==null&&typeof e=="object"){if(typeof e.then=="function")return Oo(e);if(e.$$typeof===$t)return ve(e)}throw Error(y(438,String(e)))}function Xl(e){var t=null,n=C.updateQueue;if(n!==null&&(t=n.memoCache),t==null){var a=C.alternate;a!==null&&(a=a.updateQueue,a!==null&&(a=a.memoCache,a!=null&&(t={data:a.data.map(function(o){return o.slice()}),index:0})))}if(t==null&&(t={data:[],index:0}),n===null&&(n=oi(),C.updateQueue=n),n.memoCache=t,n=t.data[t.index],n===void 0)for(n=t.data[t.index]=Array(e),a=0;a<e;a++)n[a]=Jh;return t.index++,n}function _t(e,t){return typeof t=="function"?t(e):t}function fr(e){var t=oe();return Ql(t,G,e)}function Ql(e,t,n){var a=e.queue;if(a===null)throw Error(y(311));a.lastRenderedReducer=n;var o=e.baseQueue,i=a.pending;if(i!==null){if(o!==null){var s=o.next;o.next=i.next,i.next=s}t.baseQueue=o=i,a.pending=null}if(i=e.baseState,o===null)e.memoizedState=i;else{t=o.next;var l=s=null,u=null,c=t,m=!1;do{var b=c.lane&-536870913;if(b!==c.lane?(_&b)===b:(zt&b)===b){var f=c.revertLane;if(f===0)u!==null&&(u=u.next={lane:0,revertLane:0,gesture:null,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null}),b===pa&&(m=!0);else if((zt&f)===f){c=c.next,f===pa&&(m=!0);continue}else b={lane:0,revertLane:c.revertLane,gesture:null,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null},u===null?(l=u=b,s=i):u=u.next=b,C.lanes|=f,un|=f;b=c.action,En&&n(i,b),i=c.hasEagerState?c.eagerState:n(i,b)}else f={lane:b,revertLane:c.revertLane,gesture:c.gesture,action:c.action,hasEagerState:c.hasEagerState,eagerState:c.eagerState,next:null},u===null?(l=u=f,s=i):u=u.next=f,C.lanes|=b,un|=b;c=c.next}while(c!==null&&c!==t);if(u===null?s=i:u.next=l,!Ge(i,e.memoizedState)&&(ue=!0,m&&(n=ra,n!==null)))throw n;e.memoizedState=i,e.baseState=s,e.baseQueue=u,a.lastRenderedState=i}return o===null&&(a.lanes=0),[e.memoizedState,a.dispatch]}function ls(e){var t=oe(),n=t.queue;if(n===null)throw Error(y(311));n.lastRenderedReducer=e;var a=n.dispatch,o=n.pending,i=t.memoizedState;if(o!==null){n.pending=null;var s=o=o.next;do i=e(i,s.action),s=s.next;while(s!==o);Ge(i,t.memoizedState)||(ue=!0),t.memoizedState=i,t.baseQueue===null&&(t.baseState=i),n.lastRenderedState=i}return[i,a]}function Ep(e,t,n){var a=C,o=oe(),i=M;if(i){if(n===void 0)throw Error(y(407));n=n()}else n=t();var s=!Ge((G||o).memoizedState,n);if(s&&(o.memoizedState=n,ue=!0),o=o.queue,Il(Op.bind(null,a,o,e),[e]),o.getSnapshot!==t||s||ie!==null&&ie.memoizedState.tag&1){if(a.flags|=2048,ga(9,{destroy:void 0},Ap.bind(null,a,o,n,t),null),V===null)throw Error(y(349));i||(zt&127)!==0||Cp(a,t,n)}return n}function Cp(e,t,n){e.flags|=16384,e={getSnapshot:t,value:n},t=C.updateQueue,t===null?(t=oi(),C.updateQueue=t,t.stores=[e]):(n=t.stores,n===null?t.stores=[e]:n.push(e))}function Ap(e,t,n,a){t.value=n,t.getSnapshot=a,Rp(t)&&zp(e)}function Op(e,t,n){return n(function(){Rp(t)&&zp(e)})}function Rp(e){var t=e.getSnapshot;e=e.value;try{var n=t();return!Ge(e,n)}catch{return!0}}function zp(e){var t=zn(e,2);t!==null&&_e(t,e,2)}function Ws(e){var t=Ee();if(typeof e=="function"){var n=e;if(e=n(),En){Yt(!0);try{n()}finally{Yt(!1)}}}return t.memoizedState=t.baseState=e,t.queue={pending:null,lanes:0,dispatch:null,lastRenderedReducer:_t,lastRenderedState:e},t}function _p(e,t,n,a){return e.baseState=n,Ql(e,G,typeof a=="function"?a:_t)}function hb(e,t,n,a,o){if(si(e))throw Error(y(485));if(e=t.action,e!==null){var i={payload:o,action:e,next:null,isTransition:!0,status:"pending",value:null,reason:null,listeners:[],then:function(s){i.listeners.push(s)}};T.T!==null?n(!0):i.isTransition=!1,a(i),n=t.pending,n===null?(i.next=t.pending=i,Mp(t,i)):(i.next=n.next,t.pending=n.next=i)}}function Mp(e,t){var n=t.action,a=t.payload,o=e.state;if(t.isTransition){var i=T.T,s={};T.T=s;try{var l=n(o,a),u=T.S;u!==null&&u(s,l),_d(e,t,l)}catch(c){Js(e,t,c)}finally{i!==null&&s.types!==null&&(i.types=s.types),T.T=i}}else try{i=n(o,a),_d(e,t,i)}catch(c){Js(e,t,c)}}function _d(e,t,n){n!==null&&typeof n=="object"&&typeof n.then=="function"?n.then(function(a){Md(e,t,a)},function(a){return Js(e,t,a)}):Md(e,t,n)}function Md(e,t,n){t.status="fulfilled",t.value=n,Bp(t),e.state=n,t=e.pending,t!==null&&(n=t.next,n===t?e.pending=null:(n=n.next,t.next=n,Mp(e,n)))}function Js(e,t,n){var a=e.pending;if(e.pending=null,a!==null){a=a.next;do t.status="rejected",t.reason=n,Bp(t),t=t.next;while(t!==a)}e.action=null}function Bp(e){e=e.listeners;for(var t=0;t<e.length;t++)(0,e[t])()}function Hp(e,t){return t}function Bd(e,t){if(M){var n=V.formState;if(n!==null){e:{var a=C;if(M){if(Z){t:{for(var o=Z,i=Je;o.nodeType!==8;){if(!i){o=null;break t}if(o=tt(o.nextSibling),o===null){o=null;break t}}i=o.data,o=i==="F!"||i==="F"?o:null}if(o){Z=tt(o.nextSibling),a=o.data==="F!";break e}}sn(a)}a=!1}a&&(t=n[0])}}return n=Ee(),n.memoizedState=n.baseState=t,a={pending:null,lanes:0,dispatch:null,lastRenderedReducer:Hp,lastRenderedState:t},n.queue=a,n=Zp.bind(null,C,a),a.dispatch=n,a=Ws(!1),i=eu.bind(null,C,!1,a.queue),a=Ee(),o={state:t,dispatch:null,action:e,pending:null},a.queue=o,n=hb.bind(null,C,o,i,n),o.dispatch=n,a.memoizedState=e,[t,n,!1]}function Hd(e){var t=oe();return Np(t,G,e)}function Np(e,t,n){if(t=Ql(e,t,Hp)[0],e=fr(_t)[0],typeof t=="object"&&t!==null&&typeof t.then=="function")try{var a=Oo(t)}catch(s){throw s===ka?ai:s}else a=t;t=oe();var o=t.queue,i=o.dispatch;return n!==t.memoizedState&&(C.flags|=2048,ga(9,{destroy:void 0},mb.bind(null,o,n),null)),[a,i,e]}function mb(e,t){e.action=t}function Nd(e){var t=oe(),n=G;if(n!==null)return Np(t,n,e);oe(),t=t.memoizedState,n=oe();var a=n.queue.dispatch;return n.memoizedState=e,[t,a,!1]}function ga(e,t,n,a){return e={tag:e,create:n,deps:a,inst:t,next:null},t=C.updateQueue,t===null&&(t=oi(),C.updateQueue=t),n=t.lastEffect,n===null?t.lastEffect=e.next=e:(a=n.next,n.next=e,e.next=a,t.lastEffect=e),e}function Dp(){return oe().memoizedState}function gr(e,t,n,a){var o=Ee();C.flags|=e,o.memoizedState=ga(1|t,{destroy:void 0},n,a===void 0?null:a)}function ii(e,t,n,a){var o=oe();a=a===void 0?null:a;var i=o.memoizedState.inst;G!==null&&a!==null&&Gl(a,G.memoizedState.deps)?o.memoizedState=ga(t,i,n,a):(C.flags|=e,o.memoizedState=ga(1|t,i,n,a))}function Dd(e,t){gr(8390656,8,e,t)}function Il(e,t){ii(2048,8,e,t)}function bb(e){C.flags|=4;var t=C.updateQueue;if(t===null)t=oi(),C.updateQueue=t,t.events=[e];else{var n=t.events;n===null?t.events=[e]:n.push(e)}}function Up(e){var t=oe().memoizedState;return bb({ref:t,nextImpl:e}),function(){if((D&2)!==0)throw Error(y(440));return t.impl.apply(void 0,arguments)}}function jp(e,t){return ii(4,2,e,t)}function Lp(e,t){return ii(4,4,e,t)}function qp(e,t){if(typeof t=="function"){e=e();var n=t(e);return function(){typeof n=="function"?n():t(null)}}if(t!=null)return e=e(),t.current=e,function(){t.current=null}}function Fp(e,t,n){n=n!=null?n.concat([e]):null,ii(4,4,qp.bind(null,t,e),n)}function Zl(){}function Gp(e,t){var n=oe();t=t===void 0?null:t;var a=n.memoizedState;return t!==null&&Gl(t,a[1])?a[0]:(n.memoizedState=[e,t],e)}function Vp(e,t){var n=oe();t=t===void 0?null:t;var a=n.memoizedState;if(t!==null&&Gl(t,a[1]))return a[0];if(a=e(),En){Yt(!0);try{e()}finally{Yt(!1)}}return n.memoizedState=[a,t],a}function Wl(e,t,n){return n===void 0||(zt&1073741824)!==0&&(_&261930)===0?e.memoizedState=t:(e.memoizedState=n,e=Mf(),C.lanes|=e,un|=e,n)}function Yp(e,t,n,a){return Ge(n,t)?n:fa.current!==null?(e=Wl(e,n,a),Ge(e,t)||(ue=!0),e):(zt&42)===0||(zt&1073741824)!==0&&(_&261930)===0?(ue=!0,e.memoizedState=n):(e=Mf(),C.lanes|=e,un|=e,t)}function Kp(e,t,n,a,o){var i=U.p;U.p=i!==0&&8>i?i:8;var s=T.T,l={};T.T=l,eu(e,!1,t,n);try{var u=o(),c=T.S;if(c!==null&&c(l,u),u!==null&&typeof u=="object"&&typeof u.then=="function"){var m=pb(u,a);to(e,t,m,Fe(e))}else to(e,t,a,Fe(e))}catch(b){to(e,t,{then:function(){},status:"rejected",reason:b},Fe())}finally{U.p=i,s!==null&&l.types!==null&&(s.types=l.types),T.T=s}}function xb(){}function el(e,t,n,a){if(e.tag!==5)throw Error(y(476));var o=Pp(e).queue;Kp(e,o,t,xn,n===null?xb:function(){return Xp(e),n(a)})}function Pp(e){var t=e.memoizedState;if(t!==null)return t;t={memoizedState:xn,baseState:xn,baseQueue:null,queue:{pending:null,lanes:0,dispatch:null,lastRenderedReducer:_t,lastRenderedState:xn},next:null};var n={};return t.next={memoizedState:n,baseState:n,baseQueue:null,queue:{pending:null,lanes:0,dispatch:null,lastRenderedReducer:_t,lastRenderedState:n},next:null},e.memoizedState=t,e=e.alternate,e!==null&&(e.memoizedState=t),t}function Xp(e){var t=Pp(e);t.next===null&&(t=e.alternate.memoizedState),to(e,t.next.queue,{},Fe())}function Jl(){return ve(vo)}function Qp(){return oe().memoizedState}function Ip(){return oe().memoizedState}function vb(e){for(var t=e.return;t!==null;){switch(t.tag){case 24:case 3:var n=Fe();e=Wt(n);var a=Jt(t,e,n);a!==null&&(_e(a,t,n),Wa(a,t,n)),t={cache:Ul()},e.payload=t;return}t=t.return}}function yb(e,t,n){var a=Fe();n={lane:a,revertLane:0,gesture:null,action:n,hasEagerState:!1,eagerState:null,next:null},si(e)?Wp(t,n):(n=Bl(e,t,n,a),n!==null&&(_e(n,e,a),Jp(n,t,a)))}function Zp(e,t,n){var a=Fe();to(e,t,n,a)}function to(e,t,n,a){var o={lane:a,revertLane:0,gesture:null,action:n,hasEagerState:!1,eagerState:null,next:null};if(si(e))Wp(t,o);else{var i=e.alternate;if(e.lanes===0&&(i===null||i.lanes===0)&&(i=t.lastRenderedReducer,i!==null))try{var s=t.lastRenderedState,l=i(s,n);if(o.hasEagerState=!0,o.eagerState=l,Ge(l,s))return ni(e,t,o,0),V===null&&ti(),!1}catch{}if(n=Bl(e,t,o,a),n!==null)return _e(n,e,a),Jp(n,t,a),!0}return!1}function eu(e,t,n,a){if(a={lane:2,revertLane:uu(),gesture:null,action:a,hasEagerState:!1,eagerState:null,next:null},si(e)){if(t)throw Error(y(479))}else t=Bl(e,n,a,2),t!==null&&_e(t,e,2)}function si(e){var t=e.alternate;return e===C||t!==null&&t===C}function Wp(e,t){sa=Br=!0;var n=e.pending;n===null?t.next=t:(t.next=n.next,n.next=t),e.pending=t}function Jp(e,t,n){if((n&4194048)!==0){var a=t.lanes;a&=e.pendingLanes,n|=a,t.lanes=n,Uc(e,n)}}var mo={readContext:ve,use:ri,useCallback:te,useContext:te,useEffect:te,useImperativeHandle:te,useLayoutEffect:te,useInsertionEffect:te,useMemo:te,useReducer:te,useRef:te,useState:te,useDebugValue:te,useDeferredValue:te,useTransition:te,useSyncExternalStore:te,useId:te,useHostTransitionStatus:te,useFormState:te,useActionState:te,useOptimistic:te,useMemoCache:te,useCacheRefresh:te};mo.useEffectEvent=te;var ef={readContext:ve,use:ri,useCallback:function(e,t){return Ee().memoizedState=[e,t===void 0?null:t],e},useContext:ve,useEffect:Dd,useImperativeHandle:function(e,t,n){n=n!=null?n.concat([e]):null,gr(4194308,4,qp.bind(null,t,e),n)},useLayoutEffect:function(e,t){return gr(4194308,4,e,t)},useInsertionEffect:function(e,t){gr(4,2,e,t)},useMemo:function(e,t){var n=Ee();t=t===void 0?null:t;var a=e();if(En){Yt(!0);try{e()}finally{Yt(!1)}}return n.memoizedState=[a,t],a},useReducer:function(e,t,n){var a=Ee();if(n!==void 0){var o=n(t);if(En){Yt(!0);try{n(t)}finally{Yt(!1)}}}else o=t;return a.memoizedState=a.baseState=o,e={pending:null,lanes:0,dispatch:null,lastRenderedReducer:e,lastRenderedState:o},a.queue=e,e=e.dispatch=yb.bind(null,C,e),[a.memoizedState,e]},useRef:function(e){var t=Ee();return e={current:e},t.memoizedState=e},useState:function(e){e=Ws(e);var t=e.queue,n=Zp.bind(null,C,t);return t.dispatch=n,[e.memoizedState,n]},useDebugValue:Zl,useDeferredValue:function(e,t){var n=Ee();return Wl(n,e,t)},useTransition:function(){var e=Ws(!1);return e=Kp.bind(null,C,e.queue,!0,!1),Ee().memoizedState=e,[!1,e]},useSyncExternalStore:function(e,t,n){var a=C,o=Ee();if(M){if(n===void 0)throw Error(y(407));n=n()}else{if(n=t(),V===null)throw Error(y(349));(_&127)!==0||Cp(a,t,n)}o.memoizedState=n;var i={value:n,getSnapshot:t};return o.queue=i,Dd(Op.bind(null,a,i,e),[e]),a.flags|=2048,ga(9,{destroy:void 0},Ap.bind(null,a,i,n,t),null),n},useId:function(){var e=Ee(),t=V.identifierPrefix;if(M){var n=ut,a=lt;n=(a&~(1<<32-qe(a)-1)).toString(32)+n,t="_"+t+"R_"+n,n=Hr++,0<n&&(t+="H"+n.toString(32)),t+="_"}else n=fb++,t="_"+t+"r_"+n.toString(32)+"_";return e.memoizedState=t},useHostTransitionStatus:Jl,useFormState:Bd,useActionState:Bd,useOptimistic:function(e){var t=Ee();t.memoizedState=t.baseState=e;var n={pending:null,lanes:0,dispatch:null,lastRenderedReducer:null,lastRenderedState:null};return t.queue=n,t=eu.bind(null,C,!0,n),n.dispatch=t,[e,t]},useMemoCache:Xl,useCacheRefresh:function(){return Ee().memoizedState=vb.bind(null,C)},useEffectEvent:function(e){var t=Ee(),n={impl:e};return t.memoizedState=n,function(){if((D&2)!==0)throw Error(y(440));return n.impl.apply(void 0,arguments)}}},tu={readContext:ve,use:ri,useCallback:Gp,useContext:ve,useEffect:Il,useImperativeHandle:Fp,useInsertionEffect:jp,useLayoutEffect:Lp,useMemo:Vp,useReducer:fr,useRef:Dp,useState:function(){return fr(_t)},useDebugValue:Zl,useDeferredValue:function(e,t){var n=oe();return Yp(n,G.memoizedState,e,t)},useTransition:function(){var e=fr(_t)[0],t=oe().memoizedState;return[typeof e=="boolean"?e:Oo(e),t]},useSyncExternalStore:Ep,useId:Qp,useHostTransitionStatus:Jl,useFormState:Hd,useActionState:Hd,useOptimistic:function(e,t){var n=oe();return _p(n,G,e,t)},useMemoCache:Xl,useCacheRefresh:Ip};tu.useEffectEvent=Up;var tf={readContext:ve,use:ri,useCallback:Gp,useContext:ve,useEffect:Il,useImperativeHandle:Fp,useInsertionEffect:jp,useLayoutEffect:Lp,useMemo:Vp,useReducer:ls,useRef:Dp,useState:function(){return ls(_t)},useDebugValue:Zl,useDeferredValue:function(e,t){var n=oe();return G===null?Wl(n,e,t):Yp(n,G.memoizedState,e,t)},useTransition:function(){var e=ls(_t)[0],t=oe().memoizedState;return[typeof e=="boolean"?e:Oo(e),t]},useSyncExternalStore:Ep,useId:Qp,useHostTransitionStatus:Jl,useFormState:Nd,useActionState:Nd,useOptimistic:function(e,t){var n=oe();return G!==null?_p(n,G,e,t):(n.baseState=e,[e,n.queue.dispatch])},useMemoCache:Xl,useCacheRefresh:Ip};tf.useEffectEvent=Up;function us(e,t,n,a){t=e.memoizedState,n=n(a,t),n=n==null?t:W({},t,n),e.memoizedState=n,e.lanes===0&&(e.updateQueue.baseState=n)}var tl={enqueueSetState:function(e,t,n){e=e._reactInternals;var a=Fe(),o=Wt(a);o.payload=t,n!=null&&(o.callback=n),t=Jt(e,o,a),t!==null&&(_e(t,e,a),Wa(t,e,a))},enqueueReplaceState:function(e,t,n){e=e._reactInternals;var a=Fe(),o=Wt(a);o.tag=1,o.payload=t,n!=null&&(o.callback=n),t=Jt(e,o,a),t!==null&&(_e(t,e,a),Wa(t,e,a))},enqueueForceUpdate:function(e,t){e=e._reactInternals;var n=Fe(),a=Wt(n);a.tag=2,t!=null&&(a.callback=t),t=Jt(e,a,n),t!==null&&(_e(t,e,n),Wa(t,e,n))}};function Ud(e,t,n,a,o,i,s){return e=e.stateNode,typeof e.shouldComponentUpdate=="function"?e.shouldComponentUpdate(a,i,s):t.prototype&&t.prototype.isPureReactComponent?!co(n,a)||!co(o,i):!0}function jd(e,t,n,a){e=t.state,typeof t.componentWillReceiveProps=="function"&&t.componentWillReceiveProps(n,a),typeof t.UNSAFE_componentWillReceiveProps=="function"&&t.UNSAFE_componentWillReceiveProps(n,a),t.state!==e&&tl.enqueueReplaceState(t,t.state,null)}function Cn(e,t){var n=t;if("ref"in t){n={};for(var a in t)a!=="ref"&&(n[a]=t[a])}if(e=e.defaultProps){n===t&&(n=W({},n));for(var o in e)n[o]===void 0&&(n[o]=e[o])}return n}function nf(e){Cr(e)}function af(e){console.error(e)}function of(e){Cr(e)}function Nr(e,t){try{var n=e.onUncaughtError;n(t.value,{componentStack:t.stack})}catch(a){setTimeout(function(){throw a})}}function Ld(e,t,n){try{var a=e.onCaughtError;a(n.value,{componentStack:n.stack,errorBoundary:t.tag===1?t.stateNode:null})}catch(o){setTimeout(function(){throw o})}}function nl(e,t,n){return n=Wt(n),n.tag=3,n.payload={element:null},n.callback=function(){Nr(e,t)},n}function rf(e){return e=Wt(e),e.tag=3,e}function sf(e,t,n,a){var o=n.type.getDerivedStateFromError;if(typeof o=="function"){var i=a.value;e.payload=function(){return o(i)},e.callback=function(){Ld(t,n,a)}}var s=n.stateNode;s!==null&&typeof s.componentDidCatch=="function"&&(e.callback=function(){Ld(t,n,a),typeof o!="function"&&(en===null?en=new Set([this]):en.add(this));var l=a.stack;this.componentDidCatch(a.value,{componentStack:l!==null?l:""})})}function wb(e,t,n,a,o){if(n.flags|=32768,a!==null&&typeof a=="object"&&typeof a.then=="function"){if(t=n.alternate,t!==null&&Sa(t,n,o,!0),n=Ve.current,n!==null){switch(n.tag){case 31:case 13:return et===null?qr():n.alternate===null&&ne===0&&(ne=3),n.flags&=-257,n.flags|=65536,n.lanes=o,a===zr?n.flags|=16384:(t=n.updateQueue,t===null?n.updateQueue=new Set([a]):t.add(a),ys(e,a,o)),!1;case 22:return n.flags|=65536,a===zr?n.flags|=16384:(t=n.updateQueue,t===null?(t={transitions:null,markerInstances:null,retryQueue:new Set([a])},n.updateQueue=t):(n=t.retryQueue,n===null?t.retryQueue=new Set([a]):n.add(a)),ys(e,a,o)),!1}throw Error(y(435,n.tag))}return ys(e,a,o),qr(),!1}if(M)return t=Ve.current,t!==null?((t.flags&65536)===0&&(t.flags|=256),t.flags|=65536,t.lanes=o,a!==Gs&&(e=Error(y(422),{cause:a}),fo(We(e,n)))):(a!==Gs&&(t=Error(y(423),{cause:a}),fo(We(t,n))),e=e.current.alternate,e.flags|=65536,o&=-o,e.lanes|=o,a=We(a,n),o=nl(e.stateNode,a,o),ss(e,o),ne!==4&&(ne=2)),!1;var i=Error(y(520),{cause:a});if(i=We(i,n),oo===null?oo=[i]:oo.push(i),ne!==4&&(ne=2),t===null)return!0;a=We(a,n),n=t;do{switch(n.tag){case 3:return n.flags|=65536,e=o&-o,n.lanes|=e,e=nl(n.stateNode,a,e),ss(n,e),!1;case 1:if(t=n.type,i=n.stateNode,(n.flags&128)===0&&(typeof t.getDerivedStateFromError=="function"||i!==null&&typeof i.componentDidCatch=="function"&&(en===null||!en.has(i))))return n.flags|=65536,o&=-o,n.lanes|=o,o=rf(o),sf(o,e,n,a),ss(n,o),!1}n=n.return}while(n!==null);return!1}var nu=Error(y(461)),ue=!1;function me(e,t,n,a){t.child=e===null?yp(t,null,n,a):Tn(t,e.child,n,a)}function qd(e,t,n,a,o){n=n.render;var i=t.ref;if("ref"in a){var s={};for(var l in a)l!=="ref"&&(s[l]=a[l])}else s=a;return $n(t),a=Vl(e,t,n,s,i,o),l=Yl(),e!==null&&!ue?(Kl(e,t,o),Mt(e,t,o)):(M&&l&&Nl(t),t.flags|=1,me(e,t,a,o),t.child)}function Fd(e,t,n,a,o){if(e===null){var i=n.type;return typeof i=="function"&&!Hl(i)&&i.defaultProps===void 0&&n.compare===null?(t.tag=15,t.type=i,lf(e,t,i,a,o)):(e=cr(n.type,null,a,t,t.mode,o),e.ref=t.ref,e.return=t,t.child=e)}if(i=e.child,!au(e,o)){var s=i.memoizedProps;if(n=n.compare,n=n!==null?n:co,n(s,a)&&e.ref===t.ref)return Mt(e,t,o)}return t.flags|=1,e=Ct(i,a),e.ref=t.ref,e.return=t,t.child=e}function lf(e,t,n,a,o){if(e!==null){var i=e.memoizedProps;if(co(i,a)&&e.ref===t.ref)if(ue=!1,t.pendingProps=a=i,au(e,o))(e.flags&131072)!==0&&(ue=!0);else return t.lanes=e.lanes,Mt(e,t,o)}return al(e,t,n,a,o)}function uf(e,t,n,a){var o=a.children,i=e!==null?e.memoizedState:null;if(e===null&&t.stateNode===null&&(t.stateNode={_visibility:1,_pendingMarkers:null,_retryCache:null,_transitions:null}),a.mode==="hidden"){if((t.flags&128)!==0){if(i=i!==null?i.baseLanes|n:n,e!==null){for(a=t.child=e.child,o=0;a!==null;)o=o|a.lanes|a.childLanes,a=a.sibling;a=o&~i}else a=0,t.child=null;return Gd(e,t,i,n,a)}if((n&536870912)!==0)t.memoizedState={baseLanes:0,cachePool:null},e!==null&&pr(t,i!==null?i.cachePool:null),i!==null?zd(t,i):Is(),kp(t);else return a=t.lanes=536870912,Gd(e,t,i!==null?i.baseLanes|n:n,n,a)}else i!==null?(pr(t,i.cachePool),zd(t,i),Gt(t),t.memoizedState=null):(e!==null&&pr(t,null),Is(),Gt(t));return me(e,t,o,n),t.child}function Ka(e,t){return e!==null&&e.tag===22||t.stateNode!==null||(t.stateNode={_visibility:1,_pendingMarkers:null,_retryCache:null,_transitions:null}),t.sibling}function Gd(e,t,n,a,o){var i=jl();return i=i===null?null:{parent:le._currentValue,pool:i},t.memoizedState={baseLanes:n,cachePool:i},e!==null&&pr(t,null),Is(),kp(t),e!==null&&Sa(e,t,a,!0),t.childLanes=o,null}function hr(e,t){return t=Dr({mode:t.mode,children:t.children},e.mode),t.ref=e.ref,e.child=t,t.return=e,t}function Vd(e,t,n){return Tn(t,e.child,null,n),e=hr(t,t.pendingProps),e.flags|=2,Ne(t),t.memoizedState=null,e}function Sb(e,t,n){var a=t.pendingProps,o=(t.flags&128)!==0;if(t.flags&=-129,e===null){if(M){if(a.mode==="hidden")return e=hr(t,a),t.lanes=536870912,Ka(null,e);if(Zs(t),(e=Z)?(e=tg(e,Je),e=e!==null&&e.data==="&"?e:null,e!==null&&(t.memoizedState={dehydrated:e,treeContext:rn!==null?{id:lt,overflow:ut}:null,retryLane:536870912,hydrationErrors:null},n=fp(e),n.return=t,t.child=n,xe=t,Z=null)):e=null,e===null)throw sn(t);return t.lanes=536870912,null}return hr(t,a)}var i=e.memoizedState;if(i!==null){var s=i.dehydrated;if(Zs(t),o)if(t.flags&256)t.flags&=-257,t=Vd(e,t,n);else if(t.memoizedState!==null)t.child=e.child,t.flags|=128,t=null;else throw Error(y(558));else if(ue||Sa(e,t,n,!1),o=(n&e.childLanes)!==0,ue||o){if(a=V,a!==null&&(s=jc(a,n),s!==0&&s!==i.retryLane))throw i.retryLane=s,zn(e,s),_e(a,e,s),nu;qr(),t=Vd(e,t,n)}else e=i.treeContext,Z=tt(s.nextSibling),xe=t,M=!0,Zt=null,Je=!1,e!==null&&hp(t,e),t=hr(t,a),t.flags|=4096;return t}return e=Ct(e.child,{mode:a.mode,children:a.children}),e.ref=t.ref,t.child=e,e.return=t,e}function mr(e,t){var n=t.ref;if(n===null)e!==null&&e.ref!==null&&(t.flags|=4194816);else{if(typeof n!="function"&&typeof n!="object")throw Error(y(284));(e===null||e.ref!==n)&&(t.flags|=4194816)}}function al(e,t,n,a,o){return $n(t),n=Vl(e,t,n,a,void 0,o),a=Yl(),e!==null&&!ue?(Kl(e,t,o),Mt(e,t,o)):(M&&a&&Nl(t),t.flags|=1,me(e,t,n,o),t.child)}function Yd(e,t,n,a,o,i){return $n(t),t.updateQueue=null,n=Tp(t,a,n,o),$p(e),a=Yl(),e!==null&&!ue?(Kl(e,t,i),Mt(e,t,i)):(M&&a&&Nl(t),t.flags|=1,me(e,t,n,i),t.child)}function Kd(e,t,n,a,o){if($n(t),t.stateNode===null){var i=Wn,s=n.contextType;typeof s=="object"&&s!==null&&(i=ve(s)),i=new n(a,i),t.memoizedState=i.state!==null&&i.state!==void 0?i.state:null,i.updater=tl,t.stateNode=i,i._reactInternals=t,i=t.stateNode,i.props=a,i.state=t.memoizedState,i.refs={},ql(t),s=n.contextType,i.context=typeof s=="object"&&s!==null?ve(s):Wn,i.state=t.memoizedState,s=n.getDerivedStateFromProps,typeof s=="function"&&(us(t,n,s,a),i.state=t.memoizedState),typeof n.getDerivedStateFromProps=="function"||typeof i.getSnapshotBeforeUpdate=="function"||typeof i.UNSAFE_componentWillMount!="function"&&typeof i.componentWillMount!="function"||(s=i.state,typeof i.componentWillMount=="function"&&i.componentWillMount(),typeof i.UNSAFE_componentWillMount=="function"&&i.UNSAFE_componentWillMount(),s!==i.state&&tl.enqueueReplaceState(i,i.state,null),eo(t,a,i,o),Ja(),i.state=t.memoizedState),typeof i.componentDidMount=="function"&&(t.flags|=4194308),a=!0}else if(e===null){i=t.stateNode;var l=t.memoizedProps,u=Cn(n,l);i.props=u;var c=i.context,m=n.contextType;s=Wn,typeof m=="object"&&m!==null&&(s=ve(m));var b=n.getDerivedStateFromProps;m=typeof b=="function"||typeof i.getSnapshotBeforeUpdate=="function",l=t.pendingProps!==l,m||typeof i.UNSAFE_componentWillReceiveProps!="function"&&typeof i.componentWillReceiveProps!="function"||(l||c!==s)&&jd(t,i,a,s),Lt=!1;var f=t.memoizedState;i.state=f,eo(t,a,i,o),Ja(),c=t.memoizedState,l||f!==c||Lt?(typeof b=="function"&&(us(t,n,b,a),c=t.memoizedState),(u=Lt||Ud(t,n,u,a,f,c,s))?(m||typeof i.UNSAFE_componentWillMount!="function"&&typeof i.componentWillMount!="function"||(typeof i.componentWillMount=="function"&&i.componentWillMount(),typeof i.UNSAFE_componentWillMount=="function"&&i.UNSAFE_componentWillMount()),typeof i.componentDidMount=="function"&&(t.flags|=4194308)):(typeof i.componentDidMount=="function"&&(t.flags|=4194308),t.memoizedProps=a,t.memoizedState=c),i.props=a,i.state=c,i.context=s,a=u):(typeof i.componentDidMount=="function"&&(t.flags|=4194308),a=!1)}else{i=t.stateNode,Xs(e,t),s=t.memoizedProps,m=Cn(n,s),i.props=m,b=t.pendingProps,f=i.context,c=n.contextType,u=Wn,typeof c=="object"&&c!==null&&(u=ve(c)),l=n.getDerivedStateFromProps,(c=typeof l=="function"||typeof i.getSnapshotBeforeUpdate=="function")||typeof i.UNSAFE_componentWillReceiveProps!="function"&&typeof i.componentWillReceiveProps!="function"||(s!==b||f!==u)&&jd(t,i,a,u),Lt=!1,f=t.memoizedState,i.state=f,eo(t,a,i,o),Ja();var h=t.memoizedState;s!==b||f!==h||Lt||e!==null&&e.dependencies!==null&&Rr(e.dependencies)?(typeof l=="function"&&(us(t,n,l,a),h=t.memoizedState),(m=Lt||Ud(t,n,m,a,f,h,u)||e!==null&&e.dependencies!==null&&Rr(e.dependencies))?(c||typeof i.UNSAFE_componentWillUpdate!="function"&&typeof i.componentWillUpdate!="function"||(typeof i.componentWillUpdate=="function"&&i.componentWillUpdate(a,h,u),typeof i.UNSAFE_componentWillUpdate=="function"&&i.UNSAFE_componentWillUpdate(a,h,u)),typeof i.componentDidUpdate=="function"&&(t.flags|=4),typeof i.getSnapshotBeforeUpdate=="function"&&(t.flags|=1024)):(typeof i.componentDidUpdate!="function"||s===e.memoizedProps&&f===e.memoizedState||(t.flags|=4),typeof i.getSnapshotBeforeUpdate!="function"||s===e.memoizedProps&&f===e.memoizedState||(t.flags|=1024),t.memoizedProps=a,t.memoizedState=h),i.props=a,i.state=h,i.context=u,a=m):(typeof i.componentDidUpdate!="function"||s===e.memoizedProps&&f===e.memoizedState||(t.flags|=4),typeof i.getSnapshotBeforeUpdate!="function"||s===e.memoizedProps&&f===e.memoizedState||(t.flags|=1024),a=!1)}return i=a,mr(e,t),a=(t.flags&128)!==0,i||a?(i=t.stateNode,n=a&&typeof n.getDerivedStateFromError!="function"?null:i.render(),t.flags|=1,e!==null&&a?(t.child=Tn(t,e.child,null,o),t.child=Tn(t,null,n,o)):me(e,t,n,o),t.memoizedState=i.state,e=t.child):e=Mt(e,t,o),e}function Pd(e,t,n,a){return kn(),t.flags|=256,me(e,t,n,a),t.child}var ds={dehydrated:null,treeContext:null,retryLane:0,hydrationErrors:null};function cs(e){return{baseLanes:e,cachePool:bp()}}function ps(e,t,n){return e=e!==null?e.childLanes&~n:0,t&&(e|=Ue),e}function df(e,t,n){var a=t.pendingProps,o=!1,i=(t.flags&128)!==0,s;if((s=i)||(s=e!==null&&e.memoizedState===null?!1:(ae.current&2)!==0),s&&(o=!0,t.flags&=-129),s=(t.flags&32)!==0,t.flags&=-33,e===null){if(M){if(o?Ft(t):Gt(t),(e=Z)?(e=tg(e,Je),e=e!==null&&e.data!=="&"?e:null,e!==null&&(t.memoizedState={dehydrated:e,treeContext:rn!==null?{id:lt,overflow:ut}:null,retryLane:536870912,hydrationErrors:null},n=fp(e),n.return=t,t.child=n,xe=t,Z=null)):e=null,e===null)throw sn(t);return bl(e)?t.lanes=32:t.lanes=536870912,null}var l=a.children;return a=a.fallback,o?(Gt(t),o=t.mode,l=Dr({mode:"hidden",children:l},o),a=vn(a,o,n,null),l.return=t,a.return=t,l.sibling=a,t.child=l,a=t.child,a.memoizedState=cs(n),a.childLanes=ps(e,s,n),t.memoizedState=ds,Ka(null,a)):(Ft(t),ol(t,l))}var u=e.memoizedState;if(u!==null&&(l=u.dehydrated,l!==null)){if(i)t.flags&256?(Ft(t),t.flags&=-257,t=fs(e,t,n)):t.memoizedState!==null?(Gt(t),t.child=e.child,t.flags|=128,t=null):(Gt(t),l=a.fallback,o=t.mode,a=Dr({mode:"visible",children:a.children},o),l=vn(l,o,n,null),l.flags|=2,a.return=t,l.return=t,a.sibling=l,t.child=a,Tn(t,e.child,null,n),a=t.child,a.memoizedState=cs(n),a.childLanes=ps(e,s,n),t.memoizedState=ds,t=Ka(null,a));else if(Ft(t),bl(l)){if(s=l.nextSibling&&l.nextSibling.dataset,s)var c=s.dgst;s=c,a=Error(y(419)),a.stack="",a.digest=s,fo({value:a,source:null,stack:null}),t=fs(e,t,n)}else if(ue||Sa(e,t,n,!1),s=(n&e.childLanes)!==0,ue||s){if(s=V,s!==null&&(a=jc(s,n),a!==0&&a!==u.retryLane))throw u.retryLane=a,zn(e,a),_e(s,e,a),nu;ml(l)||qr(),t=fs(e,t,n)}else ml(l)?(t.flags|=192,t.child=e.child,t=null):(e=u.treeContext,Z=tt(l.nextSibling),xe=t,M=!0,Zt=null,Je=!1,e!==null&&hp(t,e),t=ol(t,a.children),t.flags|=4096);return t}return o?(Gt(t),l=a.fallback,o=t.mode,u=e.child,c=u.sibling,a=Ct(u,{mode:"hidden",children:a.children}),a.subtreeFlags=u.subtreeFlags&65011712,c!==null?l=Ct(c,l):(l=vn(l,o,n,null),l.flags|=2),l.return=t,a.return=t,a.sibling=l,t.child=a,Ka(null,a),a=t.child,l=e.child.memoizedState,l===null?l=cs(n):(o=l.cachePool,o!==null?(u=le._currentValue,o=o.parent!==u?{parent:u,pool:u}:o):o=bp(),l={baseLanes:l.baseLanes|n,cachePool:o}),a.memoizedState=l,a.childLanes=ps(e,s,n),t.memoizedState=ds,Ka(e.child,a)):(Ft(t),n=e.child,e=n.sibling,n=Ct(n,{mode:"visible",children:a.children}),n.return=t,n.sibling=null,e!==null&&(s=t.deletions,s===null?(t.deletions=[e],t.flags|=16):s.push(e)),t.child=n,t.memoizedState=null,n)}function ol(e,t){return t=Dr({mode:"visible",children:t},e.mode),t.return=e,e.child=t}function Dr(e,t){return e=De(22,e,null,t),e.lanes=0,e}function fs(e,t,n){return Tn(t,e.child,null,n),e=ol(t,t.pendingProps.children),e.flags|=2,t.memoizedState=null,e}function Xd(e,t,n){e.lanes|=t;var a=e.alternate;a!==null&&(a.lanes|=t),Ys(e.return,t,n)}function gs(e,t,n,a,o,i){var s=e.memoizedState;s===null?e.memoizedState={isBackwards:t,rendering:null,renderingStartTime:0,last:a,tail:n,tailMode:o,treeForkCount:i}:(s.isBackwards=t,s.rendering=null,s.renderingStartTime=0,s.last=a,s.tail=n,s.tailMode=o,s.treeForkCount=i)}function cf(e,t,n){var a=t.pendingProps,o=a.revealOrder,i=a.tail;a=a.children;var s=ae.current,l=(s&2)!==0;if(l?(s=s&1|2,t.flags|=128):s&=1,K(ae,s),me(e,t,a,n),a=M?po:0,!l&&e!==null&&(e.flags&128)!==0)e:for(e=t.child;e!==null;){if(e.tag===13)e.memoizedState!==null&&Xd(e,n,t);else if(e.tag===19)Xd(e,n,t);else if(e.child!==null){e.child.return=e,e=e.child;continue}if(e===t)break e;for(;e.sibling===null;){if(e.return===null||e.return===t)break e;e=e.return}e.sibling.return=e.return,e=e.sibling}switch(o){case"forwards":for(n=t.child,o=null;n!==null;)e=n.alternate,e!==null&&Mr(e)===null&&(o=n),n=n.sibling;n=o,n===null?(o=t.child,t.child=null):(o=n.sibling,n.sibling=null),gs(t,!1,o,n,i,a);break;case"backwards":case"unstable_legacy-backwards":for(n=null,o=t.child,t.child=null;o!==null;){if(e=o.alternate,e!==null&&Mr(e)===null){t.child=o;break}e=o.sibling,o.sibling=n,n=o,o=e}gs(t,!0,n,null,i,a);break;case"together":gs(t,!1,null,null,void 0,a);break;default:t.memoizedState=null}return t.child}function Mt(e,t,n){if(e!==null&&(t.dependencies=e.dependencies),un|=t.lanes,(n&t.childLanes)===0)if(e!==null){if(Sa(e,t,n,!1),(n&t.childLanes)===0)return null}else return null;if(e!==null&&t.child!==e.child)throw Error(y(153));if(t.child!==null){for(e=t.child,n=Ct(e,e.pendingProps),t.child=n,n.return=t;e.sibling!==null;)e=e.sibling,n=n.sibling=Ct(e,e.pendingProps),n.return=t;n.sibling=null}return t.child}function au(e,t){return(e.lanes&t)!==0?!0:(e=e.dependencies,!!(e!==null&&Rr(e)))}function kb(e,t,n){switch(t.tag){case 3:kr(t,t.stateNode.containerInfo),qt(t,le,e.memoizedState.cache),kn();break;case 27:case 5:_s(t);break;case 4:kr(t,t.stateNode.containerInfo);break;case 10:qt(t,t.type,t.memoizedProps.value);break;case 31:if(t.memoizedState!==null)return t.flags|=128,Zs(t),null;break;case 13:var a=t.memoizedState;if(a!==null)return a.dehydrated!==null?(Ft(t),t.flags|=128,null):(n&t.child.childLanes)!==0?df(e,t,n):(Ft(t),e=Mt(e,t,n),e!==null?e.sibling:null);Ft(t);break;case 19:var o=(e.flags&128)!==0;if(a=(n&t.childLanes)!==0,a||(Sa(e,t,n,!1),a=(n&t.childLanes)!==0),o){if(a)return cf(e,t,n);t.flags|=128}if(o=t.memoizedState,o!==null&&(o.rendering=null,o.tail=null,o.lastEffect=null),K(ae,ae.current),a)break;return null;case 22:return t.lanes=0,uf(e,t,n,t.pendingProps);case 24:qt(t,le,e.memoizedState.cache)}return Mt(e,t,n)}function pf(e,t,n){if(e!==null)if(e.memoizedProps!==t.pendingProps)ue=!0;else{if(!au(e,n)&&(t.flags&128)===0)return ue=!1,kb(e,t,n);ue=(e.flags&131072)!==0}else ue=!1,M&&(t.flags&1048576)!==0&&gp(t,po,t.index);switch(t.lanes=0,t.tag){case 16:e:{var a=t.pendingProps;if(e=mn(t.elementType),t.type=e,typeof e=="function")Hl(e)?(a=Cn(e,a),t.tag=1,t=Kd(null,t,e,a,n)):(t.tag=0,t=al(null,t,e,a,n));else{if(e!=null){var o=e.$$typeof;if(o===wl){t.tag=11,t=qd(null,t,e,a,n);break e}else if(o===Sl){t.tag=14,t=Fd(null,t,e,a,n);break e}}throw t=Rs(e)||e,Error(y(306,t,""))}}return t;case 0:return al(e,t,t.type,t.pendingProps,n);case 1:return a=t.type,o=Cn(a,t.pendingProps),Kd(e,t,a,o,n);case 3:e:{if(kr(t,t.stateNode.containerInfo),e===null)throw Error(y(387));a=t.pendingProps;var i=t.memoizedState;o=i.element,Xs(e,t),eo(t,a,null,n);var s=t.memoizedState;if(a=s.cache,qt(t,le,a),a!==i.cache&&Ks(t,[le],n,!0),Ja(),a=s.element,i.isDehydrated)if(i={element:a,isDehydrated:!1,cache:s.cache},t.updateQueue.baseState=i,t.memoizedState=i,t.flags&256){t=Pd(e,t,a,n);break e}else if(a!==o){o=We(Error(y(424)),t),fo(o),t=Pd(e,t,a,n);break e}else for(e=t.stateNode.containerInfo,e.nodeType===9?e=e.body:e=e.nodeName==="HTML"?e.ownerDocument.body:e,Z=tt(e.firstChild),xe=t,M=!0,Zt=null,Je=!0,n=yp(t,null,a,n),t.child=n;n;)n.flags=n.flags&-3|4096,n=n.sibling;else{if(kn(),a===o){t=Mt(e,t,n);break e}me(e,t,a,n)}t=t.child}return t;case 26:return mr(e,t),e===null?(n=mc(t.type,null,t.pendingProps,null))?t.memoizedState=n:M||(n=t.type,e=t.pendingProps,a=Yr(It.current).createElement(n),a[be]=t,a[Me]=e,ye(a,n,e),fe(a),t.stateNode=a):t.memoizedState=mc(t.type,e.memoizedProps,t.pendingProps,e.memoizedState),null;case 27:return _s(t),e===null&&M&&(a=t.stateNode=ng(t.type,t.pendingProps,It.current),xe=t,Je=!0,o=Z,cn(t.type)?(xl=o,Z=tt(a.firstChild)):Z=o),me(e,t,t.pendingProps.children,n),mr(e,t),e===null&&(t.flags|=4194304),t.child;case 5:return e===null&&M&&((o=a=Z)&&(a=Zb(a,t.type,t.pendingProps,Je),a!==null?(t.stateNode=a,xe=t,Z=tt(a.firstChild),Je=!1,o=!0):o=!1),o||sn(t)),_s(t),o=t.type,i=t.pendingProps,s=e!==null?e.memoizedProps:null,a=i.children,gl(o,i)?a=null:s!==null&&gl(o,s)&&(t.flags|=32),t.memoizedState!==null&&(o=Vl(e,t,gb,null,null,n),vo._currentValue=o),mr(e,t),me(e,t,a,n),t.child;case 6:return e===null&&M&&((e=n=Z)&&(n=Wb(n,t.pendingProps,Je),n!==null?(t.stateNode=n,xe=t,Z=null,e=!0):e=!1),e||sn(t)),null;case 13:return df(e,t,n);case 4:return kr(t,t.stateNode.containerInfo),a=t.pendingProps,e===null?t.child=Tn(t,null,a,n):me(e,t,a,n),t.child;case 11:return qd(e,t,t.type,t.pendingProps,n);case 7:return me(e,t,t.pendingProps,n),t.child;case 8:return me(e,t,t.pendingProps.children,n),t.child;case 12:return me(e,t,t.pendingProps.children,n),t.child;case 10:return a=t.pendingProps,qt(t,t.type,a.value),me(e,t,a.children,n),t.child;case 9:return o=t.type._context,a=t.pendingProps.children,$n(t),o=ve(o),a=a(o),t.flags|=1,me(e,t,a,n),t.child;case 14:return Fd(e,t,t.type,t.pendingProps,n);case 15:return lf(e,t,t.type,t.pendingProps,n);case 19:return cf(e,t,n);case 31:return Sb(e,t,n);case 22:return uf(e,t,n,t.pendingProps);case 24:return $n(t),a=ve(le),e===null?(o=jl(),o===null&&(o=V,i=Ul(),o.pooledCache=i,i.refCount++,i!==null&&(o.pooledCacheLanes|=n),o=i),t.memoizedState={parent:a,cache:o},ql(t),qt(t,le,o)):((e.lanes&n)!==0&&(Xs(e,t),eo(t,null,null,n),Ja()),o=e.memoizedState,i=t.memoizedState,o.parent!==a?(o={parent:a,cache:a},t.memoizedState=o,t.lanes===0&&(t.memoizedState=t.updateQueue.baseState=o),qt(t,le,a)):(a=i.cache,qt(t,le,a),a!==o.cache&&Ks(t,[le],n,!0))),me(e,t,t.pendingProps.children,n),t.child;case 29:throw t.pendingProps}throw Error(y(156,t.tag))}function xt(e){e.flags|=4}function hs(e,t,n,a,o){if((t=(e.mode&32)!==0)&&(t=!1),t){if(e.flags|=16777216,(o&335544128)===o)if(e.stateNode.complete)e.flags|=8192;else if(Nf())e.flags|=8192;else throw wn=zr,Ll}else e.flags&=-16777217}function Qd(e,t){if(t.type!=="stylesheet"||(t.state.loading&4)!==0)e.flags&=-16777217;else if(e.flags|=16777216,!rg(t))if(Nf())e.flags|=8192;else throw wn=zr,Ll}function er(e,t){t!==null&&(e.flags|=4),e.flags&16384&&(t=e.tag!==22?Nc():536870912,e.lanes|=t,ha|=t)}function ja(e,t){if(!M)switch(e.tailMode){case"hidden":t=e.tail;for(var n=null;t!==null;)t.alternate!==null&&(n=t),t=t.sibling;n===null?e.tail=null:n.sibling=null;break;case"collapsed":n=e.tail;for(var a=null;n!==null;)n.alternate!==null&&(a=n),n=n.sibling;a===null?t||e.tail===null?e.tail=null:e.tail.sibling=null:a.sibling=null}}function I(e){var t=e.alternate!==null&&e.alternate.child===e.child,n=0,a=0;if(t)for(var o=e.child;o!==null;)n|=o.lanes|o.childLanes,a|=o.subtreeFlags&65011712,a|=o.flags&65011712,o.return=e,o=o.sibling;else for(o=e.child;o!==null;)n|=o.lanes|o.childLanes,a|=o.subtreeFlags,a|=o.flags,o.return=e,o=o.sibling;return e.subtreeFlags|=a,e.childLanes=n,t}function $b(e,t,n){var a=t.pendingProps;switch(Dl(t),t.tag){case 16:case 15:case 0:case 11:case 7:case 8:case 12:case 9:case 14:return I(t),null;case 1:return I(t),null;case 3:return n=t.stateNode,a=null,e!==null&&(a=e.memoizedState.cache),t.memoizedState.cache!==a&&(t.flags|=2048),At(le),ua(),n.pendingContext&&(n.context=n.pendingContext,n.pendingContext=null),(e===null||e.child===null)&&(Ln(t)?xt(t):e===null||e.memoizedState.isDehydrated&&(t.flags&256)===0||(t.flags|=1024,is())),I(t),null;case 26:var o=t.type,i=t.memoizedState;return e===null?(xt(t),i!==null?(I(t),Qd(t,i)):(I(t),hs(t,o,null,a,n))):i?i!==e.memoizedState?(xt(t),I(t),Qd(t,i)):(I(t),t.flags&=-16777217):(e=e.memoizedProps,e!==a&&xt(t),I(t),hs(t,o,e,a,n)),null;case 27:if($r(t),n=It.current,o=t.type,e!==null&&t.stateNode!=null)e.memoizedProps!==a&&xt(t);else{if(!a){if(t.stateNode===null)throw Error(y(166));return I(t),null}e=ct.current,Ln(t)?$d(t,e):(e=ng(o,a,n),t.stateNode=e,xt(t))}return I(t),null;case 5:if($r(t),o=t.type,e!==null&&t.stateNode!=null)e.memoizedProps!==a&&xt(t);else{if(!a){if(t.stateNode===null)throw Error(y(166));return I(t),null}if(i=ct.current,Ln(t))$d(t,i);else{var s=Yr(It.current);switch(i){case 1:i=s.createElementNS("http://www.w3.org/2000/svg",o);break;case 2:i=s.createElementNS("http://www.w3.org/1998/Math/MathML",o);break;default:switch(o){case"svg":i=s.createElementNS("http://www.w3.org/2000/svg",o);break;case"math":i=s.createElementNS("http://www.w3.org/1998/Math/MathML",o);break;case"script":i=s.createElement("div"),i.innerHTML="<script><\/script>",i=i.removeChild(i.firstChild);break;case"select":i=typeof a.is=="string"?s.createElement("select",{is:a.is}):s.createElement("select"),a.multiple?i.multiple=!0:a.size&&(i.size=a.size);break;default:i=typeof a.is=="string"?s.createElement(o,{is:a.is}):s.createElement(o)}}i[be]=t,i[Me]=a;e:for(s=t.child;s!==null;){if(s.tag===5||s.tag===6)i.appendChild(s.stateNode);else if(s.tag!==4&&s.tag!==27&&s.child!==null){s.child.return=s,s=s.child;continue}if(s===t)break e;for(;s.sibling===null;){if(s.return===null||s.return===t)break e;s=s.return}s.sibling.return=s.return,s=s.sibling}t.stateNode=i;e:switch(ye(i,o,a),o){case"button":case"input":case"select":case"textarea":a=!!a.autoFocus;break e;case"img":a=!0;break e;default:a=!1}a&&xt(t)}}return I(t),hs(t,t.type,e===null?null:e.memoizedProps,t.pendingProps,n),null;case 6:if(e&&t.stateNode!=null)e.memoizedProps!==a&&xt(t);else{if(typeof a!="string"&&t.stateNode===null)throw Error(y(166));if(e=It.current,Ln(t)){if(e=t.stateNode,n=t.memoizedProps,a=null,o=xe,o!==null)switch(o.tag){case 27:case 5:a=o.memoizedProps}e[be]=t,e=!!(e.nodeValue===n||a!==null&&a.suppressHydrationWarning===!0||Wf(e.nodeValue,n)),e||sn(t,!0)}else e=Yr(e).createTextNode(a),e[be]=t,t.stateNode=e}return I(t),null;case 31:if(n=t.memoizedState,e===null||e.memoizedState!==null){if(a=Ln(t),n!==null){if(e===null){if(!a)throw Error(y(318));if(e=t.memoizedState,e=e!==null?e.dehydrated:null,!e)throw Error(y(557));e[be]=t}else kn(),(t.flags&128)===0&&(t.memoizedState=null),t.flags|=4;I(t),e=!1}else n=is(),e!==null&&e.memoizedState!==null&&(e.memoizedState.hydrationErrors=n),e=!0;if(!e)return t.flags&256?(Ne(t),t):(Ne(t),null);if((t.flags&128)!==0)throw Error(y(558))}return I(t),null;case 13:if(a=t.memoizedState,e===null||e.memoizedState!==null&&e.memoizedState.dehydrated!==null){if(o=Ln(t),a!==null&&a.dehydrated!==null){if(e===null){if(!o)throw Error(y(318));if(o=t.memoizedState,o=o!==null?o.dehydrated:null,!o)throw Error(y(317));o[be]=t}else kn(),(t.flags&128)===0&&(t.memoizedState=null),t.flags|=4;I(t),o=!1}else o=is(),e!==null&&e.memoizedState!==null&&(e.memoizedState.hydrationErrors=o),o=!0;if(!o)return t.flags&256?(Ne(t),t):(Ne(t),null)}return Ne(t),(t.flags&128)!==0?(t.lanes=n,t):(n=a!==null,e=e!==null&&e.memoizedState!==null,n&&(a=t.child,o=null,a.alternate!==null&&a.alternate.memoizedState!==null&&a.alternate.memoizedState.cachePool!==null&&(o=a.alternate.memoizedState.cachePool.pool),i=null,a.memoizedState!==null&&a.memoizedState.cachePool!==null&&(i=a.memoizedState.cachePool.pool),i!==o&&(a.flags|=2048)),n!==e&&n&&(t.child.flags|=8192),er(t,t.updateQueue),I(t),null);case 4:return ua(),e===null&&du(t.stateNode.containerInfo),I(t),null;case 10:return At(t.type),I(t),null;case 19:if(ge(ae),a=t.memoizedState,a===null)return I(t),null;if(o=(t.flags&128)!==0,i=a.rendering,i===null)if(o)ja(a,!1);else{if(ne!==0||e!==null&&(e.flags&128)!==0)for(e=t.child;e!==null;){if(i=Mr(e),i!==null){for(t.flags|=128,ja(a,!1),e=i.updateQueue,t.updateQueue=e,er(t,e),t.subtreeFlags=0,e=n,n=t.child;n!==null;)pp(n,e),n=n.sibling;return K(ae,ae.current&1|2),M&&St(t,a.treeForkCount),t.child}e=e.sibling}a.tail!==null&&je()>jr&&(t.flags|=128,o=!0,ja(a,!1),t.lanes=4194304)}else{if(!o)if(e=Mr(i),e!==null){if(t.flags|=128,o=!0,e=e.updateQueue,t.updateQueue=e,er(t,e),ja(a,!0),a.tail===null&&a.tailMode==="hidden"&&!i.alternate&&!M)return I(t),null}else 2*je()-a.renderingStartTime>jr&&n!==536870912&&(t.flags|=128,o=!0,ja(a,!1),t.lanes=4194304);a.isBackwards?(i.sibling=t.child,t.child=i):(e=a.last,e!==null?e.sibling=i:t.child=i,a.last=i)}return a.tail!==null?(e=a.tail,a.rendering=e,a.tail=e.sibling,a.renderingStartTime=je(),e.sibling=null,n=ae.current,K(ae,o?n&1|2:n&1),M&&St(t,a.treeForkCount),e):(I(t),null);case 22:case 23:return Ne(t),Fl(),a=t.memoizedState!==null,e!==null?e.memoizedState!==null!==a&&(t.flags|=8192):a&&(t.flags|=8192),a?(n&536870912)!==0&&(t.flags&128)===0&&(I(t),t.subtreeFlags&6&&(t.flags|=8192)):I(t),n=t.updateQueue,n!==null&&er(t,n.retryQueue),n=null,e!==null&&e.memoizedState!==null&&e.memoizedState.cachePool!==null&&(n=e.memoizedState.cachePool.pool),a=null,t.memoizedState!==null&&t.memoizedState.cachePool!==null&&(a=t.memoizedState.cachePool.pool),a!==n&&(t.flags|=2048),e!==null&&ge(yn),null;case 24:return n=null,e!==null&&(n=e.memoizedState.cache),t.memoizedState.cache!==n&&(t.flags|=2048),At(le),I(t),null;case 25:return null;case 30:return null}throw Error(y(156,t.tag))}function Tb(e,t){switch(Dl(t),t.tag){case 1:return e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 3:return At(le),ua(),e=t.flags,(e&65536)!==0&&(e&128)===0?(t.flags=e&-65537|128,t):null;case 26:case 27:case 5:return $r(t),null;case 31:if(t.memoizedState!==null){if(Ne(t),t.alternate===null)throw Error(y(340));kn()}return e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 13:if(Ne(t),e=t.memoizedState,e!==null&&e.dehydrated!==null){if(t.alternate===null)throw Error(y(340));kn()}return e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 19:return ge(ae),null;case 4:return ua(),null;case 10:return At(t.type),null;case 22:case 23:return Ne(t),Fl(),e!==null&&ge(yn),e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 24:return At(le),null;case 25:return null;default:return null}}function ff(e,t){switch(Dl(t),t.tag){case 3:At(le),ua();break;case 26:case 27:case 5:$r(t);break;case 4:ua();break;case 31:t.memoizedState!==null&&Ne(t);break;case 13:Ne(t);break;case 19:ge(ae);break;case 10:At(t.type);break;case 22:case 23:Ne(t),Fl(),e!==null&&ge(yn);break;case 24:At(le)}}function Ro(e,t){try{var n=t.updateQueue,a=n!==null?n.lastEffect:null;if(a!==null){var o=a.next;n=o;do{if((n.tag&e)===e){a=void 0;var i=n.create,s=n.inst;a=i(),s.destroy=a}n=n.next}while(n!==o)}}catch(l){q(t,t.return,l)}}function ln(e,t,n){try{var a=t.updateQueue,o=a!==null?a.lastEffect:null;if(o!==null){var i=o.next;a=i;do{if((a.tag&e)===e){var s=a.inst,l=s.destroy;if(l!==void 0){s.destroy=void 0,o=t;var u=n,c=l;try{c()}catch(m){q(o,u,m)}}}a=a.next}while(a!==i)}}catch(m){q(t,t.return,m)}}function gf(e){var t=e.updateQueue;if(t!==null){var n=e.stateNode;try{Sp(t,n)}catch(a){q(e,e.return,a)}}}function hf(e,t,n){n.props=Cn(e.type,e.memoizedProps),n.state=e.memoizedState;try{n.componentWillUnmount()}catch(a){q(e,t,a)}}function no(e,t){try{var n=e.ref;if(n!==null){switch(e.tag){case 26:case 27:case 5:var a=e.stateNode;break;case 30:a=e.stateNode;break;default:a=e.stateNode}typeof n=="function"?e.refCleanup=n(a):n.current=a}}catch(o){q(e,t,o)}}function dt(e,t){var n=e.ref,a=e.refCleanup;if(n!==null)if(typeof a=="function")try{a()}catch(o){q(e,t,o)}finally{e.refCleanup=null,e=e.alternate,e!=null&&(e.refCleanup=null)}else if(typeof n=="function")try{n(null)}catch(o){q(e,t,o)}else n.current=null}function mf(e){var t=e.type,n=e.memoizedProps,a=e.stateNode;try{e:switch(t){case"button":case"input":case"select":case"textarea":n.autoFocus&&a.focus();break e;case"img":n.src?a.src=n.src:n.srcSet&&(a.srcset=n.srcSet)}}catch(o){q(e,e.return,o)}}function ms(e,t,n){try{var a=e.stateNode;Yb(a,e.type,n,t),a[Me]=t}catch(o){q(e,e.return,o)}}function bf(e){return e.tag===5||e.tag===3||e.tag===26||e.tag===27&&cn(e.type)||e.tag===4}function bs(e){e:for(;;){for(;e.sibling===null;){if(e.return===null||bf(e.return))return null;e=e.return}for(e.sibling.return=e.return,e=e.sibling;e.tag!==5&&e.tag!==6&&e.tag!==18;){if(e.tag===27&&cn(e.type)||e.flags&2||e.child===null||e.tag===4)continue e;e.child.return=e,e=e.child}if(!(e.flags&2))return e.stateNode}}function rl(e,t,n){var a=e.tag;if(a===5||a===6)e=e.stateNode,t?(n.nodeType===9?n.body:n.nodeName==="HTML"?n.ownerDocument.body:n).insertBefore(e,t):(t=n.nodeType===9?n.body:n.nodeName==="HTML"?n.ownerDocument.body:n,t.appendChild(e),n=n._reactRootContainer,n!=null||t.onclick!==null||(t.onclick=Tt));else if(a!==4&&(a===27&&cn(e.type)&&(n=e.stateNode,t=null),e=e.child,e!==null))for(rl(e,t,n),e=e.sibling;e!==null;)rl(e,t,n),e=e.sibling}function Ur(e,t,n){var a=e.tag;if(a===5||a===6)e=e.stateNode,t?n.insertBefore(e,t):n.appendChild(e);else if(a!==4&&(a===27&&cn(e.type)&&(n=e.stateNode),e=e.child,e!==null))for(Ur(e,t,n),e=e.sibling;e!==null;)Ur(e,t,n),e=e.sibling}function xf(e){var t=e.stateNode,n=e.memoizedProps;try{for(var a=e.type,o=t.attributes;o.length;)t.removeAttributeNode(o[0]);ye(t,a,n),t[be]=e,t[Me]=n}catch(i){q(e,e.return,i)}}var kt=!1,se=!1,xs=!1,Id=typeof WeakSet=="function"?WeakSet:Set,pe=null;function Eb(e,t){if(e=e.containerInfo,pl=Qr,e=op(e),_l(e)){if("selectionStart"in e)var n={start:e.selectionStart,end:e.selectionEnd};else e:{n=(n=e.ownerDocument)&&n.defaultView||window;var a=n.getSelection&&n.getSelection();if(a&&a.rangeCount!==0){n=a.anchorNode;var o=a.anchorOffset,i=a.focusNode;a=a.focusOffset;try{n.nodeType,i.nodeType}catch{n=null;break e}var s=0,l=-1,u=-1,c=0,m=0,b=e,f=null;t:for(;;){for(var h;b!==n||o!==0&&b.nodeType!==3||(l=s+o),b!==i||a!==0&&b.nodeType!==3||(u=s+a),b.nodeType===3&&(s+=b.nodeValue.length),(h=b.firstChild)!==null;)f=b,b=h;for(;;){if(b===e)break t;if(f===n&&++c===o&&(l=s),f===i&&++m===a&&(u=s),(h=b.nextSibling)!==null)break;b=f,f=b.parentNode}b=h}n=l===-1||u===-1?null:{start:l,end:u}}else n=null}n=n||{start:0,end:0}}else n=null;for(fl={focusedElem:e,selectionRange:n},Qr=!1,pe=t;pe!==null;)if(t=pe,e=t.child,(t.subtreeFlags&1028)!==0&&e!==null)e.return=t,pe=e;else for(;pe!==null;){switch(t=pe,i=t.alternate,e=t.flags,t.tag){case 0:if((e&4)!==0&&(e=t.updateQueue,e=e!==null?e.events:null,e!==null))for(n=0;n<e.length;n++)o=e[n],o.ref.impl=o.nextImpl;break;case 11:case 15:break;case 1:if((e&1024)!==0&&i!==null){e=void 0,n=t,o=i.memoizedProps,i=i.memoizedState,a=n.stateNode;try{var w=Cn(n.type,o);e=a.getSnapshotBeforeUpdate(w,i),a.__reactInternalSnapshotBeforeUpdate=e}catch($){q(n,n.return,$)}}break;case 3:if((e&1024)!==0){if(e=t.stateNode.containerInfo,n=e.nodeType,n===9)hl(e);else if(n===1)switch(e.nodeName){case"HEAD":case"HTML":case"BODY":hl(e);break;default:e.textContent=""}}break;case 5:case 26:case 27:case 6:case 4:case 17:break;default:if((e&1024)!==0)throw Error(y(163))}if(e=t.sibling,e!==null){e.return=t.return,pe=e;break}pe=t.return}}function vf(e,t,n){var a=n.flags;switch(n.tag){case 0:case 11:case 15:yt(e,n),a&4&&Ro(5,n);break;case 1:if(yt(e,n),a&4)if(e=n.stateNode,t===null)try{e.componentDidMount()}catch(s){q(n,n.return,s)}else{var o=Cn(n.type,t.memoizedProps);t=t.memoizedState;try{e.componentDidUpdate(o,t,e.__reactInternalSnapshotBeforeUpdate)}catch(s){q(n,n.return,s)}}a&64&&gf(n),a&512&&no(n,n.return);break;case 3:if(yt(e,n),a&64&&(e=n.updateQueue,e!==null)){if(t=null,n.child!==null)switch(n.child.tag){case 27:case 5:t=n.child.stateNode;break;case 1:t=n.child.stateNode}try{Sp(e,t)}catch(s){q(n,n.return,s)}}break;case 27:t===null&&a&4&&xf(n);case 26:case 5:yt(e,n),t===null&&a&4&&mf(n),a&512&&no(n,n.return);break;case 12:yt(e,n);break;case 31:yt(e,n),a&4&&Sf(e,n);break;case 13:yt(e,n),a&4&&kf(e,n),a&64&&(e=n.memoizedState,e!==null&&(e=e.dehydrated,e!==null&&(n=Hb.bind(null,n),Jb(e,n))));break;case 22:if(a=n.memoizedState!==null||kt,!a){t=t!==null&&t.memoizedState!==null||se,o=kt;var i=se;kt=a,(se=t)&&!i?wt(e,n,(n.subtreeFlags&8772)!==0):yt(e,n),kt=o,se=i}break;case 30:break;default:yt(e,n)}}function yf(e){var t=e.alternate;t!==null&&(e.alternate=null,yf(t)),e.child=null,e.deletions=null,e.sibling=null,e.tag===5&&(t=e.stateNode,t!==null&&El(t)),e.stateNode=null,e.return=null,e.dependencies=null,e.memoizedProps=null,e.memoizedState=null,e.pendingProps=null,e.stateNode=null,e.updateQueue=null}var ee=null,Re=!1;function vt(e,t,n){for(n=n.child;n!==null;)wf(e,t,n),n=n.sibling}function wf(e,t,n){if(Le&&typeof Le.onCommitFiberUnmount=="function")try{Le.onCommitFiberUnmount(ko,n)}catch{}switch(n.tag){case 26:se||dt(n,t),vt(e,t,n),n.memoizedState?n.memoizedState.count--:n.stateNode&&(n=n.stateNode,n.parentNode.removeChild(n));break;case 27:se||dt(n,t);var a=ee,o=Re;cn(n.type)&&(ee=n.stateNode,Re=!1),vt(e,t,n),io(n.stateNode),ee=a,Re=o;break;case 5:se||dt(n,t);case 6:if(a=ee,o=Re,ee=null,vt(e,t,n),ee=a,Re=o,ee!==null)if(Re)try{(ee.nodeType===9?ee.body:ee.nodeName==="HTML"?ee.ownerDocument.body:ee).removeChild(n.stateNode)}catch(i){q(n,t,i)}else try{ee.removeChild(n.stateNode)}catch(i){q(n,t,i)}break;case 18:ee!==null&&(Re?(e=ee,cc(e.nodeType===9?e.body:e.nodeName==="HTML"?e.ownerDocument.body:e,n.stateNode),va(e)):cc(ee,n.stateNode));break;case 4:a=ee,o=Re,ee=n.stateNode.containerInfo,Re=!0,vt(e,t,n),ee=a,Re=o;break;case 0:case 11:case 14:case 15:ln(2,n,t),se||ln(4,n,t),vt(e,t,n);break;case 1:se||(dt(n,t),a=n.stateNode,typeof a.componentWillUnmount=="function"&&hf(n,t,a)),vt(e,t,n);break;case 21:vt(e,t,n);break;case 22:se=(a=se)||n.memoizedState!==null,vt(e,t,n),se=a;break;default:vt(e,t,n)}}function Sf(e,t){if(t.memoizedState===null&&(e=t.alternate,e!==null&&(e=e.memoizedState,e!==null))){e=e.dehydrated;try{va(e)}catch(n){q(t,t.return,n)}}}function kf(e,t){if(t.memoizedState===null&&(e=t.alternate,e!==null&&(e=e.memoizedState,e!==null&&(e=e.dehydrated,e!==null))))try{va(e)}catch(n){q(t,t.return,n)}}function Cb(e){switch(e.tag){case 31:case 13:case 19:var t=e.stateNode;return t===null&&(t=e.stateNode=new Id),t;case 22:return e=e.stateNode,t=e._retryCache,t===null&&(t=e._retryCache=new Id),t;default:throw Error(y(435,e.tag))}}function tr(e,t){var n=Cb(e);t.forEach(function(a){if(!n.has(a)){n.add(a);var o=Nb.bind(null,e,a);a.then(o,o)}})}function Ae(e,t){var n=t.deletions;if(n!==null)for(var a=0;a<n.length;a++){var o=n[a],i=e,s=t,l=s;e:for(;l!==null;){switch(l.tag){case 27:if(cn(l.type)){ee=l.stateNode,Re=!1;break e}break;case 5:ee=l.stateNode,Re=!1;break e;case 3:case 4:ee=l.stateNode.containerInfo,Re=!0;break e}l=l.return}if(ee===null)throw Error(y(160));wf(i,s,o),ee=null,Re=!1,i=o.alternate,i!==null&&(i.return=null),o.return=null}if(t.subtreeFlags&13886)for(t=t.child;t!==null;)$f(t,e),t=t.sibling}var rt=null;function $f(e,t){var n=e.alternate,a=e.flags;switch(e.tag){case 0:case 11:case 14:case 15:Ae(t,e),Oe(e),a&4&&(ln(3,e,e.return),Ro(3,e),ln(5,e,e.return));break;case 1:Ae(t,e),Oe(e),a&512&&(se||n===null||dt(n,n.return)),a&64&&kt&&(e=e.updateQueue,e!==null&&(a=e.callbacks,a!==null&&(n=e.shared.hiddenCallbacks,e.shared.hiddenCallbacks=n===null?a:n.concat(a))));break;case 26:var o=rt;if(Ae(t,e),Oe(e),a&512&&(se||n===null||dt(n,n.return)),a&4){var i=n!==null?n.memoizedState:null;if(a=e.memoizedState,n===null)if(a===null)if(e.stateNode===null){e:{a=e.type,n=e.memoizedProps,o=o.ownerDocument||o;t:switch(a){case"title":i=o.getElementsByTagName("title")[0],(!i||i[Eo]||i[be]||i.namespaceURI==="http://www.w3.org/2000/svg"||i.hasAttribute("itemprop"))&&(i=o.createElement(a),o.head.insertBefore(i,o.querySelector("head > title"))),ye(i,a,n),i[be]=e,fe(i),a=i;break e;case"link":var s=xc("link","href",o).get(a+(n.href||""));if(s){for(var l=0;l<s.length;l++)if(i=s[l],i.getAttribute("href")===(n.href==null||n.href===""?null:n.href)&&i.getAttribute("rel")===(n.rel==null?null:n.rel)&&i.getAttribute("title")===(n.title==null?null:n.title)&&i.getAttribute("crossorigin")===(n.crossOrigin==null?null:n.crossOrigin)){s.splice(l,1);break t}}i=o.createElement(a),ye(i,a,n),o.head.appendChild(i);break;case"meta":if(s=xc("meta","content",o).get(a+(n.content||""))){for(l=0;l<s.length;l++)if(i=s[l],i.getAttribute("content")===(n.content==null?null:""+n.content)&&i.getAttribute("name")===(n.name==null?null:n.name)&&i.getAttribute("property")===(n.property==null?null:n.property)&&i.getAttribute("http-equiv")===(n.httpEquiv==null?null:n.httpEquiv)&&i.getAttribute("charset")===(n.charSet==null?null:n.charSet)){s.splice(l,1);break t}}i=o.createElement(a),ye(i,a,n),o.head.appendChild(i);break;default:throw Error(y(468,a))}i[be]=e,fe(i),a=i}e.stateNode=a}else vc(o,e.type,e.stateNode);else e.stateNode=bc(o,a,e.memoizedProps);else i!==a?(i===null?n.stateNode!==null&&(n=n.stateNode,n.parentNode.removeChild(n)):i.count--,a===null?vc(o,e.type,e.stateNode):bc(o,a,e.memoizedProps)):a===null&&e.stateNode!==null&&ms(e,e.memoizedProps,n.memoizedProps)}break;case 27:Ae(t,e),Oe(e),a&512&&(se||n===null||dt(n,n.return)),n!==null&&a&4&&ms(e,e.memoizedProps,n.memoizedProps);break;case 5:if(Ae(t,e),Oe(e),a&512&&(se||n===null||dt(n,n.return)),e.flags&32){o=e.stateNode;try{ca(o,"")}catch(w){q(e,e.return,w)}}a&4&&e.stateNode!=null&&(o=e.memoizedProps,ms(e,o,n!==null?n.memoizedProps:o)),a&1024&&(xs=!0);break;case 6:if(Ae(t,e),Oe(e),a&4){if(e.stateNode===null)throw Error(y(162));a=e.memoizedProps,n=e.stateNode;try{n.nodeValue=a}catch(w){q(e,e.return,w)}}break;case 3:if(vr=null,o=rt,rt=Kr(t.containerInfo),Ae(t,e),rt=o,Oe(e),a&4&&n!==null&&n.memoizedState.isDehydrated)try{va(t.containerInfo)}catch(w){q(e,e.return,w)}xs&&(xs=!1,Tf(e));break;case 4:a=rt,rt=Kr(e.stateNode.containerInfo),Ae(t,e),Oe(e),rt=a;break;case 12:Ae(t,e),Oe(e);break;case 31:Ae(t,e),Oe(e),a&4&&(a=e.updateQueue,a!==null&&(e.updateQueue=null,tr(e,a)));break;case 13:Ae(t,e),Oe(e),e.child.flags&8192&&e.memoizedState!==null!=(n!==null&&n.memoizedState!==null)&&(li=je()),a&4&&(a=e.updateQueue,a!==null&&(e.updateQueue=null,tr(e,a)));break;case 22:o=e.memoizedState!==null;var u=n!==null&&n.memoizedState!==null,c=kt,m=se;if(kt=c||o,se=m||u,Ae(t,e),se=m,kt=c,Oe(e),a&8192)e:for(t=e.stateNode,t._visibility=o?t._visibility&-2:t._visibility|1,o&&(n===null||u||kt||se||bn(e)),n=null,t=e;;){if(t.tag===5||t.tag===26){if(n===null){u=n=t;try{if(i=u.stateNode,o)s=i.style,typeof s.setProperty=="function"?s.setProperty("display","none","important"):s.display="none";else{l=u.stateNode;var b=u.memoizedProps.style,f=b!=null&&b.hasOwnProperty("display")?b.display:null;l.style.display=f==null||typeof f=="boolean"?"":(""+f).trim()}}catch(w){q(u,u.return,w)}}}else if(t.tag===6){if(n===null){u=t;try{u.stateNode.nodeValue=o?"":u.memoizedProps}catch(w){q(u,u.return,w)}}}else if(t.tag===18){if(n===null){u=t;try{var h=u.stateNode;o?pc(h,!0):pc(u.stateNode,!1)}catch(w){q(u,u.return,w)}}}else if((t.tag!==22&&t.tag!==23||t.memoizedState===null||t===e)&&t.child!==null){t.child.return=t,t=t.child;continue}if(t===e)break e;for(;t.sibling===null;){if(t.return===null||t.return===e)break e;n===t&&(n=null),t=t.return}n===t&&(n=null),t.sibling.return=t.return,t=t.sibling}a&4&&(a=e.updateQueue,a!==null&&(n=a.retryQueue,n!==null&&(a.retryQueue=null,tr(e,n))));break;case 19:Ae(t,e),Oe(e),a&4&&(a=e.updateQueue,a!==null&&(e.updateQueue=null,tr(e,a)));break;case 30:break;case 21:break;default:Ae(t,e),Oe(e)}}function Oe(e){var t=e.flags;if(t&2){try{for(var n,a=e.return;a!==null;){if(bf(a)){n=a;break}a=a.return}if(n==null)throw Error(y(160));switch(n.tag){case 27:var o=n.stateNode,i=bs(e);Ur(e,i,o);break;case 5:var s=n.stateNode;n.flags&32&&(ca(s,""),n.flags&=-33);var l=bs(e);Ur(e,l,s);break;case 3:case 4:var u=n.stateNode.containerInfo,c=bs(e);rl(e,c,u);break;default:throw Error(y(161))}}catch(m){q(e,e.return,m)}e.flags&=-3}t&4096&&(e.flags&=-4097)}function Tf(e){if(e.subtreeFlags&1024)for(e=e.child;e!==null;){var t=e;Tf(t),t.tag===5&&t.flags&1024&&t.stateNode.reset(),e=e.sibling}}function yt(e,t){if(t.subtreeFlags&8772)for(t=t.child;t!==null;)vf(e,t.alternate,t),t=t.sibling}function bn(e){for(e=e.child;e!==null;){var t=e;switch(t.tag){case 0:case 11:case 14:case 15:ln(4,t,t.return),bn(t);break;case 1:dt(t,t.return);var n=t.stateNode;typeof n.componentWillUnmount=="function"&&hf(t,t.return,n),bn(t);break;case 27:io(t.stateNode);case 26:case 5:dt(t,t.return),bn(t);break;case 22:t.memoizedState===null&&bn(t);break;case 30:bn(t);break;default:bn(t)}e=e.sibling}}function wt(e,t,n){for(n=n&&(t.subtreeFlags&8772)!==0,t=t.child;t!==null;){var a=t.alternate,o=e,i=t,s=i.flags;switch(i.tag){case 0:case 11:case 15:wt(o,i,n),Ro(4,i);break;case 1:if(wt(o,i,n),a=i,o=a.stateNode,typeof o.componentDidMount=="function")try{o.componentDidMount()}catch(c){q(a,a.return,c)}if(a=i,o=a.updateQueue,o!==null){var l=a.stateNode;try{var u=o.shared.hiddenCallbacks;if(u!==null)for(o.shared.hiddenCallbacks=null,o=0;o<u.length;o++)wp(u[o],l)}catch(c){q(a,a.return,c)}}n&&s&64&&gf(i),no(i,i.return);break;case 27:xf(i);case 26:case 5:wt(o,i,n),n&&a===null&&s&4&&mf(i),no(i,i.return);break;case 12:wt(o,i,n);break;case 31:wt(o,i,n),n&&s&4&&Sf(o,i);break;case 13:wt(o,i,n),n&&s&4&&kf(o,i);break;case 22:i.memoizedState===null&&wt(o,i,n),no(i,i.return);break;case 30:break;default:wt(o,i,n)}t=t.sibling}}function ou(e,t){var n=null;e!==null&&e.memoizedState!==null&&e.memoizedState.cachePool!==null&&(n=e.memoizedState.cachePool.pool),e=null,t.memoizedState!==null&&t.memoizedState.cachePool!==null&&(e=t.memoizedState.cachePool.pool),e!==n&&(e!=null&&e.refCount++,n!=null&&Ao(n))}function ru(e,t){e=null,t.alternate!==null&&(e=t.alternate.memoizedState.cache),t=t.memoizedState.cache,t!==e&&(t.refCount++,e!=null&&Ao(e))}function ot(e,t,n,a){if(t.subtreeFlags&10256)for(t=t.child;t!==null;)Ef(e,t,n,a),t=t.sibling}function Ef(e,t,n,a){var o=t.flags;switch(t.tag){case 0:case 11:case 15:ot(e,t,n,a),o&2048&&Ro(9,t);break;case 1:ot(e,t,n,a);break;case 3:ot(e,t,n,a),o&2048&&(e=null,t.alternate!==null&&(e=t.alternate.memoizedState.cache),t=t.memoizedState.cache,t!==e&&(t.refCount++,e!=null&&Ao(e)));break;case 12:if(o&2048){ot(e,t,n,a),e=t.stateNode;try{var i=t.memoizedProps,s=i.id,l=i.onPostCommit;typeof l=="function"&&l(s,t.alternate===null?"mount":"update",e.passiveEffectDuration,-0)}catch(u){q(t,t.return,u)}}else ot(e,t,n,a);break;case 31:ot(e,t,n,a);break;case 13:ot(e,t,n,a);break;case 23:break;case 22:i=t.stateNode,s=t.alternate,t.memoizedState!==null?i._visibility&2?ot(e,t,n,a):ao(e,t):i._visibility&2?ot(e,t,n,a):(i._visibility|=2,Fn(e,t,n,a,(t.subtreeFlags&10256)!==0||!1)),o&2048&&ou(s,t);break;case 24:ot(e,t,n,a),o&2048&&ru(t.alternate,t);break;default:ot(e,t,n,a)}}function Fn(e,t,n,a,o){for(o=o&&((t.subtreeFlags&10256)!==0||!1),t=t.child;t!==null;){var i=e,s=t,l=n,u=a,c=s.flags;switch(s.tag){case 0:case 11:case 15:Fn(i,s,l,u,o),Ro(8,s);break;case 23:break;case 22:var m=s.stateNode;s.memoizedState!==null?m._visibility&2?Fn(i,s,l,u,o):ao(i,s):(m._visibility|=2,Fn(i,s,l,u,o)),o&&c&2048&&ou(s.alternate,s);break;case 24:Fn(i,s,l,u,o),o&&c&2048&&ru(s.alternate,s);break;default:Fn(i,s,l,u,o)}t=t.sibling}}function ao(e,t){if(t.subtreeFlags&10256)for(t=t.child;t!==null;){var n=e,a=t,o=a.flags;switch(a.tag){case 22:ao(n,a),o&2048&&ou(a.alternate,a);break;case 24:ao(n,a),o&2048&&ru(a.alternate,a);break;default:ao(n,a)}t=t.sibling}}var Pa=8192;function qn(e,t,n){if(e.subtreeFlags&Pa)for(e=e.child;e!==null;)Cf(e,t,n),e=e.sibling}function Cf(e,t,n){switch(e.tag){case 26:qn(e,t,n),e.flags&Pa&&e.memoizedState!==null&&cx(n,rt,e.memoizedState,e.memoizedProps);break;case 5:qn(e,t,n);break;case 3:case 4:var a=rt;rt=Kr(e.stateNode.containerInfo),qn(e,t,n),rt=a;break;case 22:e.memoizedState===null&&(a=e.alternate,a!==null&&a.memoizedState!==null?(a=Pa,Pa=16777216,qn(e,t,n),Pa=a):qn(e,t,n));break;default:qn(e,t,n)}}function Af(e){var t=e.alternate;if(t!==null&&(e=t.child,e!==null)){t.child=null;do t=e.sibling,e.sibling=null,e=t;while(e!==null)}}function La(e){var t=e.deletions;if((e.flags&16)!==0){if(t!==null)for(var n=0;n<t.length;n++){var a=t[n];pe=a,Rf(a,e)}Af(e)}if(e.subtreeFlags&10256)for(e=e.child;e!==null;)Of(e),e=e.sibling}function Of(e){switch(e.tag){case 0:case 11:case 15:La(e),e.flags&2048&&ln(9,e,e.return);break;case 3:La(e);break;case 12:La(e);break;case 22:var t=e.stateNode;e.memoizedState!==null&&t._visibility&2&&(e.return===null||e.return.tag!==13)?(t._visibility&=-3,br(e)):La(e);break;default:La(e)}}function br(e){var t=e.deletions;if((e.flags&16)!==0){if(t!==null)for(var n=0;n<t.length;n++){var a=t[n];pe=a,Rf(a,e)}Af(e)}for(e=e.child;e!==null;){switch(t=e,t.tag){case 0:case 11:case 15:ln(8,t,t.return),br(t);break;case 22:n=t.stateNode,n._visibility&2&&(n._visibility&=-3,br(t));break;default:br(t)}e=e.sibling}}function Rf(e,t){for(;pe!==null;){var n=pe;switch(n.tag){case 0:case 11:case 15:ln(8,n,t);break;case 23:case 22:if(n.memoizedState!==null&&n.memoizedState.cachePool!==null){var a=n.memoizedState.cachePool.pool;a!=null&&a.refCount++}break;case 24:Ao(n.memoizedState.cache)}if(a=n.child,a!==null)a.return=n,pe=a;else e:for(n=e;pe!==null;){a=pe;var o=a.sibling,i=a.return;if(yf(a),a===n){pe=null;break e}if(o!==null){o.return=i,pe=o;break e}pe=i}}}var Ab={getCacheForType:function(e){var t=ve(le),n=t.data.get(e);return n===void 0&&(n=e(),t.data.set(e,n)),n},cacheSignal:function(){return ve(le).controller.signal}},Ob=typeof WeakMap=="function"?WeakMap:Map,D=0,V=null,R=null,_=0,L=0,He=null,Pt=!1,$a=!1,iu=!1,Bt=0,ne=0,un=0,Sn=0,su=0,Ue=0,ha=0,oo=null,ze=null,il=!1,li=0,zf=0,jr=1/0,Lr=null,en=null,de=0,tn=null,ma=null,Ot=0,sl=0,ll=null,_f=null,ro=0,ul=null;function Fe(){return(D&2)!==0&&_!==0?_&-_:T.T!==null?uu():Lc()}function Mf(){if(Ue===0)if((_&536870912)===0||M){var e=Yo;Yo<<=1,(Yo&3932160)===0&&(Yo=262144),Ue=e}else Ue=536870912;return e=Ve.current,e!==null&&(e.flags|=32),Ue}function _e(e,t,n){(e===V&&(L===2||L===9)||e.cancelPendingCommit!==null)&&(ba(e,0),Xt(e,_,Ue,!1)),To(e,n),((D&2)===0||e!==V)&&(e===V&&((D&2)===0&&(Sn|=n),ne===4&&Xt(e,_,Ue,!1)),ft(e))}function Bf(e,t,n){if((D&6)!==0)throw Error(y(327));var a=!n&&(t&127)===0&&(t&e.expiredLanes)===0||$o(e,t),o=a?_b(e,t):vs(e,t,!0),i=a;do{if(o===0){$a&&!a&&Xt(e,t,0,!1);break}else{if(n=e.current.alternate,i&&!Rb(n)){o=vs(e,t,!1),i=!1;continue}if(o===2){if(i=t,e.errorRecoveryDisabledLanes&i)var s=0;else s=e.pendingLanes&-536870913,s=s!==0?s:s&536870912?536870912:0;if(s!==0){t=s;e:{var l=e;o=oo;var u=l.current.memoizedState.isDehydrated;if(u&&(ba(l,s).flags|=256),s=vs(l,s,!1),s!==2){if(iu&&!u){l.errorRecoveryDisabledLanes|=i,Sn|=i,o=4;break e}i=ze,ze=o,i!==null&&(ze===null?ze=i:ze.push.apply(ze,i))}o=s}if(i=!1,o!==2)continue}}if(o===1){ba(e,0),Xt(e,t,0,!0);break}e:{switch(a=e,i=o,i){case 0:case 1:throw Error(y(345));case 4:if((t&4194048)!==t)break;case 6:Xt(a,t,Ue,!Pt);break e;case 2:ze=null;break;case 3:case 5:break;default:throw Error(y(329))}if((t&62914560)===t&&(o=li+300-je(),10<o)){if(Xt(a,t,Ue,!Pt),Zr(a,0,!0)!==0)break e;Ot=t,a.timeoutHandle=eg(Zd.bind(null,a,n,ze,Lr,il,t,Ue,Sn,ha,Pt,i,"Throttled",-0,0),o);break e}Zd(a,n,ze,Lr,il,t,Ue,Sn,ha,Pt,i,null,-0,0)}}break}while(!0);ft(e)}function Zd(e,t,n,a,o,i,s,l,u,c,m,b,f,h){if(e.timeoutHandle=-1,b=t.subtreeFlags,b&8192||(b&16785408)===16785408){b={stylesheets:null,count:0,imgCount:0,imgBytes:0,suspenseyImages:[],waitingForImages:!0,waitingForViewTransition:!1,unsuspend:Tt},Cf(t,i,b);var w=(i&62914560)===i?li-je():(i&4194048)===i?zf-je():0;if(w=px(b,w),w!==null){Ot=i,e.cancelPendingCommit=w(Jd.bind(null,e,t,i,n,a,o,s,l,u,m,b,null,f,h)),Xt(e,i,s,!c);return}}Jd(e,t,i,n,a,o,s,l,u)}function Rb(e){for(var t=e;;){var n=t.tag;if((n===0||n===11||n===15)&&t.flags&16384&&(n=t.updateQueue,n!==null&&(n=n.stores,n!==null)))for(var a=0;a<n.length;a++){var o=n[a],i=o.getSnapshot;o=o.value;try{if(!Ge(i(),o))return!1}catch{return!1}}if(n=t.child,t.subtreeFlags&16384&&n!==null)n.return=t,t=n;else{if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return!0;t=t.return}t.sibling.return=t.return,t=t.sibling}}return!0}function Xt(e,t,n,a){t&=~su,t&=~Sn,e.suspendedLanes|=t,e.pingedLanes&=~t,a&&(e.warmLanes|=t),a=e.expirationTimes;for(var o=t;0<o;){var i=31-qe(o),s=1<<i;a[i]=-1,o&=~s}n!==0&&Dc(e,n,t)}function ui(){return(D&6)===0?(zo(0,!1),!1):!0}function lu(){if(R!==null){if(L===0)var e=R.return;else e=R,Et=_n=null,Pl(e),ia=null,go=0,e=R;for(;e!==null;)ff(e.alternate,e),e=e.return;R=null}}function ba(e,t){var n=e.timeoutHandle;n!==-1&&(e.timeoutHandle=-1,Xb(n)),n=e.cancelPendingCommit,n!==null&&(e.cancelPendingCommit=null,n()),Ot=0,lu(),V=e,R=n=Ct(e.current,null),_=t,L=0,He=null,Pt=!1,$a=$o(e,t),iu=!1,ha=Ue=su=Sn=un=ne=0,ze=oo=null,il=!1,(t&8)!==0&&(t|=t&32);var a=e.entangledLanes;if(a!==0)for(e=e.entanglements,a&=t;0<a;){var o=31-qe(a),i=1<<o;t|=e[o],a&=~i}return Bt=t,ti(),n}function Hf(e,t){C=null,T.H=mo,t===ka||t===ai?(t=Od(),L=3):t===Ll?(t=Od(),L=4):L=t===nu?8:t!==null&&typeof t=="object"&&typeof t.then=="function"?6:1,He=t,R===null&&(ne=1,Nr(e,We(t,e.current)))}function Nf(){var e=Ve.current;return e===null?!0:(_&4194048)===_?et===null:(_&62914560)===_||(_&536870912)!==0?e===et:!1}function Df(){var e=T.H;return T.H=mo,e===null?mo:e}function Uf(){var e=T.A;return T.A=Ab,e}function qr(){ne=4,Pt||(_&4194048)!==_&&Ve.current!==null||($a=!0),(un&134217727)===0&&(Sn&134217727)===0||V===null||Xt(V,_,Ue,!1)}function vs(e,t,n){var a=D;D|=2;var o=Df(),i=Uf();(V!==e||_!==t)&&(Lr=null,ba(e,t)),t=!1;var s=ne;e:do try{if(L!==0&&R!==null){var l=R,u=He;switch(L){case 8:lu(),s=6;break e;case 3:case 2:case 9:case 6:Ve.current===null&&(t=!0);var c=L;if(L=0,He=null,ta(e,l,u,c),n&&$a){s=0;break e}break;default:c=L,L=0,He=null,ta(e,l,u,c)}}zb(),s=ne;break}catch(m){Hf(e,m)}while(!0);return t&&e.shellSuspendCounter++,Et=_n=null,D=a,T.H=o,T.A=i,R===null&&(V=null,_=0,ti()),s}function zb(){for(;R!==null;)jf(R)}function _b(e,t){var n=D;D|=2;var a=Df(),o=Uf();V!==e||_!==t?(Lr=null,jr=je()+500,ba(e,t)):$a=$o(e,t);e:do try{if(L!==0&&R!==null){t=R;var i=He;t:switch(L){case 1:L=0,He=null,ta(e,t,i,1);break;case 2:case 9:if(Ad(i)){L=0,He=null,Wd(t);break}t=function(){L!==2&&L!==9||V!==e||(L=7),ft(e)},i.then(t,t);break e;case 3:L=7;break e;case 4:L=5;break e;case 7:Ad(i)?(L=0,He=null,Wd(t)):(L=0,He=null,ta(e,t,i,7));break;case 5:var s=null;switch(R.tag){case 26:s=R.memoizedState;case 5:case 27:var l=R;if(s?rg(s):l.stateNode.complete){L=0,He=null;var u=l.sibling;if(u!==null)R=u;else{var c=l.return;c!==null?(R=c,di(c)):R=null}break t}}L=0,He=null,ta(e,t,i,5);break;case 6:L=0,He=null,ta(e,t,i,6);break;case 8:lu(),ne=6;break e;default:throw Error(y(462))}}Mb();break}catch(m){Hf(e,m)}while(!0);return Et=_n=null,T.H=a,T.A=o,D=n,R!==null?0:(V=null,_=0,ti(),ne)}function Mb(){for(;R!==null&&!nm();)jf(R)}function jf(e){var t=pf(e.alternate,e,Bt);e.memoizedProps=e.pendingProps,t===null?di(e):R=t}function Wd(e){var t=e,n=t.alternate;switch(t.tag){case 15:case 0:t=Yd(n,t,t.pendingProps,t.type,void 0,_);break;case 11:t=Yd(n,t,t.pendingProps,t.type.render,t.ref,_);break;case 5:Pl(t);default:ff(n,t),t=R=pp(t,Bt),t=pf(n,t,Bt)}e.memoizedProps=e.pendingProps,t===null?di(e):R=t}function ta(e,t,n,a){Et=_n=null,Pl(t),ia=null,go=0;var o=t.return;try{if(wb(e,o,t,n,_)){ne=1,Nr(e,We(n,e.current)),R=null;return}}catch(i){if(o!==null)throw R=o,i;ne=1,Nr(e,We(n,e.current)),R=null;return}t.flags&32768?(M||a===1?e=!0:$a||(_&536870912)!==0?e=!1:(Pt=e=!0,(a===2||a===9||a===3||a===6)&&(a=Ve.current,a!==null&&a.tag===13&&(a.flags|=16384))),Lf(t,e)):di(t)}function di(e){var t=e;do{if((t.flags&32768)!==0){Lf(t,Pt);return}e=t.return;var n=$b(t.alternate,t,Bt);if(n!==null){R=n;return}if(t=t.sibling,t!==null){R=t;return}R=t=e}while(t!==null);ne===0&&(ne=5)}function Lf(e,t){do{var n=Tb(e.alternate,e);if(n!==null){n.flags&=32767,R=n;return}if(n=e.return,n!==null&&(n.flags|=32768,n.subtreeFlags=0,n.deletions=null),!t&&(e=e.sibling,e!==null)){R=e;return}R=e=n}while(e!==null);ne=6,R=null}function Jd(e,t,n,a,o,i,s,l,u){e.cancelPendingCommit=null;do ci();while(de!==0);if((D&6)!==0)throw Error(y(327));if(t!==null){if(t===e.current)throw Error(y(177));if(i=t.lanes|t.childLanes,i|=Ml,pm(e,n,i,s,l,u),e===V&&(R=V=null,_=0),ma=t,tn=e,Ot=n,sl=i,ll=o,_f=a,(t.subtreeFlags&10256)!==0||(t.flags&10256)!==0?(e.callbackNode=null,e.callbackPriority=0,Db(Tr,function(){return Yf(),null})):(e.callbackNode=null,e.callbackPriority=0),a=(t.flags&13878)!==0,(t.subtreeFlags&13878)!==0||a){a=T.T,T.T=null,o=U.p,U.p=2,s=D,D|=4;try{Eb(e,t,n)}finally{D=s,U.p=o,T.T=a}}de=1,qf(),Ff(),Gf()}}function qf(){if(de===1){de=0;var e=tn,t=ma,n=(t.flags&13878)!==0;if((t.subtreeFlags&13878)!==0||n){n=T.T,T.T=null;var a=U.p;U.p=2;var o=D;D|=4;try{$f(t,e);var i=fl,s=op(e.containerInfo),l=i.focusedElem,u=i.selectionRange;if(s!==l&&l&&l.ownerDocument&&ap(l.ownerDocument.documentElement,l)){if(u!==null&&_l(l)){var c=u.start,m=u.end;if(m===void 0&&(m=c),"selectionStart"in l)l.selectionStart=c,l.selectionEnd=Math.min(m,l.value.length);else{var b=l.ownerDocument||document,f=b&&b.defaultView||window;if(f.getSelection){var h=f.getSelection(),w=l.textContent.length,$=Math.min(u.start,w),B=u.end===void 0?$:Math.min(u.end,w);!h.extend&&$>B&&(s=B,B=$,$=s);var p=wd(l,$),d=wd(l,B);if(p&&d&&(h.rangeCount!==1||h.anchorNode!==p.node||h.anchorOffset!==p.offset||h.focusNode!==d.node||h.focusOffset!==d.offset)){var g=b.createRange();g.setStart(p.node,p.offset),h.removeAllRanges(),$>B?(h.addRange(g),h.extend(d.node,d.offset)):(g.setEnd(d.node,d.offset),h.addRange(g))}}}}for(b=[],h=l;h=h.parentNode;)h.nodeType===1&&b.push({element:h,left:h.scrollLeft,top:h.scrollTop});for(typeof l.focus=="function"&&l.focus(),l=0;l<b.length;l++){var v=b[l];v.element.scrollLeft=v.left,v.element.scrollTop=v.top}}Qr=!!pl,fl=pl=null}finally{D=o,U.p=a,T.T=n}}e.current=t,de=2}}function Ff(){if(de===2){de=0;var e=tn,t=ma,n=(t.flags&8772)!==0;if((t.subtreeFlags&8772)!==0||n){n=T.T,T.T=null;var a=U.p;U.p=2;var o=D;D|=4;try{vf(e,t.alternate,t)}finally{D=o,U.p=a,T.T=n}}de=3}}function Gf(){if(de===4||de===3){de=0,am();var e=tn,t=ma,n=Ot,a=_f;(t.subtreeFlags&10256)!==0||(t.flags&10256)!==0?de=5:(de=0,ma=tn=null,Vf(e,e.pendingLanes));var o=e.pendingLanes;if(o===0&&(en=null),Tl(n),t=t.stateNode,Le&&typeof Le.onCommitFiberRoot=="function")try{Le.onCommitFiberRoot(ko,t,void 0,(t.current.flags&128)===128)}catch{}if(a!==null){t=T.T,o=U.p,U.p=2,T.T=null;try{for(var i=e.onRecoverableError,s=0;s<a.length;s++){var l=a[s];i(l.value,{componentStack:l.stack})}}finally{T.T=t,U.p=o}}(Ot&3)!==0&&ci(),ft(e),o=e.pendingLanes,(n&261930)!==0&&(o&42)!==0?e===ul?ro++:(ro=0,ul=e):ro=0,zo(0,!1)}}function Vf(e,t){(e.pooledCacheLanes&=t)===0&&(t=e.pooledCache,t!=null&&(e.pooledCache=null,Ao(t)))}function ci(){return qf(),Ff(),Gf(),Yf()}function Yf(){if(de!==5)return!1;var e=tn,t=sl;sl=0;var n=Tl(Ot),a=T.T,o=U.p;try{U.p=32>n?32:n,T.T=null,n=ll,ll=null;var i=tn,s=Ot;if(de=0,ma=tn=null,Ot=0,(D&6)!==0)throw Error(y(331));var l=D;if(D|=4,Of(i.current),Ef(i,i.current,s,n),D=l,zo(0,!1),Le&&typeof Le.onPostCommitFiberRoot=="function")try{Le.onPostCommitFiberRoot(ko,i)}catch{}return!0}finally{U.p=o,T.T=a,Vf(e,t)}}function ec(e,t,n){t=We(n,t),t=nl(e.stateNode,t,2),e=Jt(e,t,2),e!==null&&(To(e,2),ft(e))}function q(e,t,n){if(e.tag===3)ec(e,e,n);else for(;t!==null;){if(t.tag===3){ec(t,e,n);break}else if(t.tag===1){var a=t.stateNode;if(typeof t.type.getDerivedStateFromError=="function"||typeof a.componentDidCatch=="function"&&(en===null||!en.has(a))){e=We(n,e),n=rf(2),a=Jt(t,n,2),a!==null&&(sf(n,a,t,e),To(a,2),ft(a));break}}t=t.return}}function ys(e,t,n){var a=e.pingCache;if(a===null){a=e.pingCache=new Ob;var o=new Set;a.set(t,o)}else o=a.get(t),o===void 0&&(o=new Set,a.set(t,o));o.has(n)||(iu=!0,o.add(n),e=Bb.bind(null,e,t,n),t.then(e,e))}function Bb(e,t,n){var a=e.pingCache;a!==null&&a.delete(t),e.pingedLanes|=e.suspendedLanes&n,e.warmLanes&=~n,V===e&&(_&n)===n&&(ne===4||ne===3&&(_&62914560)===_&&300>je()-li?(D&2)===0&&ba(e,0):su|=n,ha===_&&(ha=0)),ft(e)}function Kf(e,t){t===0&&(t=Nc()),e=zn(e,t),e!==null&&(To(e,t),ft(e))}function Hb(e){var t=e.memoizedState,n=0;t!==null&&(n=t.retryLane),Kf(e,n)}function Nb(e,t){var n=0;switch(e.tag){case 31:case 13:var a=e.stateNode,o=e.memoizedState;o!==null&&(n=o.retryLane);break;case 19:a=e.stateNode;break;case 22:a=e.stateNode._retryCache;break;default:throw Error(y(314))}a!==null&&a.delete(t),Kf(e,n)}function Db(e,t){return kl(e,t)}var Fr=null,Gn=null,dl=!1,Gr=!1,ws=!1,Qt=0;function ft(e){e!==Gn&&e.next===null&&(Gn===null?Fr=Gn=e:Gn=Gn.next=e),Gr=!0,dl||(dl=!0,jb())}function zo(e,t){if(!ws&&Gr){ws=!0;do for(var n=!1,a=Fr;a!==null;){if(!t)if(e!==0){var o=a.pendingLanes;if(o===0)var i=0;else{var s=a.suspendedLanes,l=a.pingedLanes;i=(1<<31-qe(42|e)+1)-1,i&=o&~(s&~l),i=i&201326741?i&201326741|1:i?i|2:0}i!==0&&(n=!0,tc(a,i))}else i=_,i=Zr(a,a===V?i:0,a.cancelPendingCommit!==null||a.timeoutHandle!==-1),(i&3)===0||$o(a,i)||(n=!0,tc(a,i));a=a.next}while(n);ws=!1}}function Ub(){Pf()}function Pf(){Gr=dl=!1;var e=0;Qt!==0&&Pb()&&(e=Qt);for(var t=je(),n=null,a=Fr;a!==null;){var o=a.next,i=Xf(a,t);i===0?(a.next=null,n===null?Fr=o:n.next=o,o===null&&(Gn=n)):(n=a,(e!==0||(i&3)!==0)&&(Gr=!0)),a=o}de!==0&&de!==5||zo(e,!1),Qt!==0&&(Qt=0)}function Xf(e,t){for(var n=e.suspendedLanes,a=e.pingedLanes,o=e.expirationTimes,i=e.pendingLanes&-62914561;0<i;){var s=31-qe(i),l=1<<s,u=o[s];u===-1?((l&n)===0||(l&a)!==0)&&(o[s]=cm(l,t)):u<=t&&(e.expiredLanes|=l),i&=~l}if(t=V,n=_,n=Zr(e,e===t?n:0,e.cancelPendingCommit!==null||e.timeoutHandle!==-1),a=e.callbackNode,n===0||e===t&&(L===2||L===9)||e.cancelPendingCommit!==null)return a!==null&&a!==null&&Ii(a),e.callbackNode=null,e.callbackPriority=0;if((n&3)===0||$o(e,n)){if(t=n&-n,t===e.callbackPriority)return t;switch(a!==null&&Ii(a),Tl(n)){case 2:case 8:n=Bc;break;case 32:n=Tr;break;case 268435456:n=Hc;break;default:n=Tr}return a=Qf.bind(null,e),n=kl(n,a),e.callbackPriority=t,e.callbackNode=n,t}return a!==null&&a!==null&&Ii(a),e.callbackPriority=2,e.callbackNode=null,2}function Qf(e,t){if(de!==0&&de!==5)return e.callbackNode=null,e.callbackPriority=0,null;var n=e.callbackNode;if(ci()&&e.callbackNode!==n)return null;var a=_;return a=Zr(e,e===V?a:0,e.cancelPendingCommit!==null||e.timeoutHandle!==-1),a===0?null:(Bf(e,a,t),Xf(e,je()),e.callbackNode!=null&&e.callbackNode===n?Qf.bind(null,e):null)}function tc(e,t){if(ci())return null;Bf(e,t,!0)}function jb(){Qb(function(){(D&6)!==0?kl(Mc,Ub):Pf()})}function uu(){if(Qt===0){var e=pa;e===0&&(e=Vo,Vo<<=1,(Vo&261888)===0&&(Vo=256)),Qt=e}return Qt}function nc(e){return e==null||typeof e=="symbol"||typeof e=="boolean"?null:typeof e=="function"?e:lr(""+e)}function ac(e,t){var n=t.ownerDocument.createElement("input");return n.name=t.name,n.value=t.value,e.id&&n.setAttribute("form",e.id),t.parentNode.insertBefore(n,t),e=new FormData(e),n.parentNode.removeChild(n),e}function Lb(e,t,n,a,o){if(t==="submit"&&n&&n.stateNode===o){var i=nc((o[Me]||null).action),s=a.submitter;s&&(t=(t=s[Me]||null)?nc(t.formAction):s.getAttribute("formAction"),t!==null&&(i=t,s=null));var l=new Wr("action","action",null,a,o);e.push({event:l,listeners:[{instance:null,listener:function(){if(a.defaultPrevented){if(Qt!==0){var u=s?ac(o,s):new FormData(o);el(n,{pending:!0,data:u,method:o.method,action:i},null,u)}}else typeof i=="function"&&(l.preventDefault(),u=s?ac(o,s):new FormData(o),el(n,{pending:!0,data:u,method:o.method,action:i},i,u))},currentTarget:o}]})}}for(nr=0;nr<Fs.length;nr++)ar=Fs[nr],oc=ar.toLowerCase(),rc=ar[0].toUpperCase()+ar.slice(1),it(oc,"on"+rc);var ar,oc,rc,nr;it(ip,"onAnimationEnd");it(sp,"onAnimationIteration");it(lp,"onAnimationStart");it("dblclick","onDoubleClick");it("focusin","onFocus");it("focusout","onBlur");it(ob,"onTransitionRun");it(rb,"onTransitionStart");it(ib,"onTransitionCancel");it(up,"onTransitionEnd");da("onMouseEnter",["mouseout","mouseover"]);da("onMouseLeave",["mouseout","mouseover"]);da("onPointerEnter",["pointerout","pointerover"]);da("onPointerLeave",["pointerout","pointerover"]);An("onChange","change click focusin focusout input keydown keyup selectionchange".split(" "));An("onSelect","focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" "));An("onBeforeInput",["compositionend","keypress","textInput","paste"]);An("onCompositionEnd","compositionend focusout keydown keypress keyup mousedown".split(" "));An("onCompositionStart","compositionstart focusout keydown keypress keyup mousedown".split(" "));An("onCompositionUpdate","compositionupdate focusout keydown keypress keyup mousedown".split(" "));var bo="abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "),qb=new Set("beforetoggle cancel close invalid load scroll scrollend toggle".split(" ").concat(bo));function If(e,t){t=(t&4)!==0;for(var n=0;n<e.length;n++){var a=e[n],o=a.event;a=a.listeners;e:{var i=void 0;if(t)for(var s=a.length-1;0<=s;s--){var l=a[s],u=l.instance,c=l.currentTarget;if(l=l.listener,u!==i&&o.isPropagationStopped())break e;i=l,o.currentTarget=c;try{i(o)}catch(m){Cr(m)}o.currentTarget=null,i=u}else for(s=0;s<a.length;s++){if(l=a[s],u=l.instance,c=l.currentTarget,l=l.listener,u!==i&&o.isPropagationStopped())break e;i=l,o.currentTarget=c;try{i(o)}catch(m){Cr(m)}o.currentTarget=null,i=u}}}}function O(e,t){var n=t[Bs];n===void 0&&(n=t[Bs]=new Set);var a=e+"__bubble";n.has(a)||(Zf(t,e,2,!1),n.add(a))}function Ss(e,t,n){var a=0;t&&(a|=4),Zf(n,e,a,t)}var or="_reactListening"+Math.random().toString(36).slice(2);function du(e){if(!e[or]){e[or]=!0,qc.forEach(function(n){n!=="selectionchange"&&(qb.has(n)||Ss(n,!1,e),Ss(n,!0,e))});var t=e.nodeType===9?e:e.ownerDocument;t===null||t[or]||(t[or]=!0,Ss("selectionchange",!1,t))}}function Zf(e,t,n,a){switch(dg(t)){case 2:var o=hx;break;case 8:o=mx;break;default:o=gu}n=o.bind(null,t,n,e),o=void 0,!js||t!=="touchstart"&&t!=="touchmove"&&t!=="wheel"||(o=!0),a?o!==void 0?e.addEventListener(t,n,{capture:!0,passive:o}):e.addEventListener(t,n,!0):o!==void 0?e.addEventListener(t,n,{passive:o}):e.addEventListener(t,n,!1)}function ks(e,t,n,a,o){var i=a;if((t&1)===0&&(t&2)===0&&a!==null)e:for(;;){if(a===null)return;var s=a.tag;if(s===3||s===4){var l=a.stateNode.containerInfo;if(l===o)break;if(s===4)for(s=a.return;s!==null;){var u=s.tag;if((u===3||u===4)&&s.stateNode.containerInfo===o)return;s=s.return}for(;l!==null;){if(s=Kn(l),s===null)return;if(u=s.tag,u===5||u===6||u===26||u===27){a=i=s;continue e}l=l.parentNode}}a=a.return}Qc(function(){var c=i,m=Al(n),b=[];e:{var f=dp.get(e);if(f!==void 0){var h=Wr,w=e;switch(e){case"keypress":if(dr(n)===0)break e;case"keydown":case"keyup":h=Nm;break;case"focusin":w="focus",h=ts;break;case"focusout":w="blur",h=ts;break;case"beforeblur":case"afterblur":h=ts;break;case"click":if(n.button===2)break e;case"auxclick":case"dblclick":case"mousedown":case"mousemove":case"mouseup":case"mouseout":case"mouseover":case"contextmenu":h=pd;break;case"drag":case"dragend":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"dragstart":case"drop":h=$m;break;case"touchcancel":case"touchend":case"touchmove":case"touchstart":h=jm;break;case ip:case sp:case lp:h=Cm;break;case up:h=qm;break;case"scroll":case"scrollend":h=Sm;break;case"wheel":h=Gm;break;case"copy":case"cut":case"paste":h=Om;break;case"gotpointercapture":case"lostpointercapture":case"pointercancel":case"pointerdown":case"pointermove":case"pointerout":case"pointerover":case"pointerup":h=gd;break;case"toggle":case"beforetoggle":h=Ym}var $=(t&4)!==0,B=!$&&(e==="scroll"||e==="scrollend"),p=$?f!==null?f+"Capture":null:f;$=[];for(var d=c,g;d!==null;){var v=d;if(g=v.stateNode,v=v.tag,v!==5&&v!==26&&v!==27||g===null||p===null||(v=lo(d,p),v!=null&&$.push(xo(d,v,g))),B)break;d=d.return}0<$.length&&(f=new h(f,w,null,n,m),b.push({event:f,listeners:$}))}}if((t&7)===0){e:{if(f=e==="mouseover"||e==="pointerover",h=e==="mouseout"||e==="pointerout",f&&n!==Us&&(w=n.relatedTarget||n.fromElement)&&(Kn(w)||w[ya]))break e;if((h||f)&&(f=m.window===m?m:(f=m.ownerDocument)?f.defaultView||f.parentWindow:window,h?(w=n.relatedTarget||n.toElement,h=c,w=w?Kn(w):null,w!==null&&(B=So(w),$=w.tag,w!==B||$!==5&&$!==27&&$!==6)&&(w=null)):(h=null,w=c),h!==w)){if($=pd,v="onMouseLeave",p="onMouseEnter",d="mouse",(e==="pointerout"||e==="pointerover")&&($=gd,v="onPointerLeave",p="onPointerEnter",d="pointer"),B=h==null?f:Ya(h),g=w==null?f:Ya(w),f=new $(v,d+"leave",h,n,m),f.target=B,f.relatedTarget=g,v=null,Kn(m)===c&&($=new $(p,d+"enter",w,n,m),$.target=g,$.relatedTarget=B,v=$),B=v,h&&w)t:{for($=Fb,p=h,d=w,g=0,v=p;v;v=$(v))g++;v=0;for(var k=d;k;k=$(k))v++;for(;0<g-v;)p=$(p),g--;for(;0<v-g;)d=$(d),v--;for(;g--;){if(p===d||d!==null&&p===d.alternate){$=p;break t}p=$(p),d=$(d)}$=null}else $=null;h!==null&&ic(b,f,h,$,!1),w!==null&&B!==null&&ic(b,B,w,$,!0)}}e:{if(f=c?Ya(c):window,h=f.nodeName&&f.nodeName.toLowerCase(),h==="select"||h==="input"&&f.type==="file")var H=xd;else if(bd(f))if(tp)H=tb;else{H=Jm;var S=Wm}else h=f.nodeName,!h||h.toLowerCase()!=="input"||f.type!=="checkbox"&&f.type!=="radio"?c&&Cl(c.elementType)&&(H=xd):H=eb;if(H&&(H=H(e,c))){ep(b,H,n,m);break e}S&&S(e,f,c),e==="focusout"&&c&&f.type==="number"&&c.memoizedProps.value!=null&&Ds(f,"number",f.value)}switch(S=c?Ya(c):window,e){case"focusin":(bd(S)||S.contentEditable==="true")&&(Qn=S,Ls=c,Ia=null);break;case"focusout":Ia=Ls=Qn=null;break;case"mousedown":qs=!0;break;case"contextmenu":case"mouseup":case"dragend":qs=!1,Sd(b,n,m);break;case"selectionchange":if(ab)break;case"keydown":case"keyup":Sd(b,n,m)}var A;if(zl)e:{switch(e){case"compositionstart":var z="onCompositionStart";break e;case"compositionend":z="onCompositionEnd";break e;case"compositionupdate":z="onCompositionUpdate";break e}z=void 0}else Xn?Wc(e,n)&&(z="onCompositionEnd"):e==="keydown"&&n.keyCode===229&&(z="onCompositionStart");z&&(Zc&&n.locale!=="ko"&&(Xn||z!=="onCompositionStart"?z==="onCompositionEnd"&&Xn&&(A=Ic()):(Kt=m,Ol="value"in Kt?Kt.value:Kt.textContent,Xn=!0)),S=Vr(c,z),0<S.length&&(z=new fd(z,e,null,n,m),b.push({event:z,listeners:S}),A?z.data=A:(A=Jc(n),A!==null&&(z.data=A)))),(A=Pm?Xm(e,n):Qm(e,n))&&(z=Vr(c,"onBeforeInput"),0<z.length&&(S=new fd("onBeforeInput","beforeinput",null,n,m),b.push({event:S,listeners:z}),S.data=A)),Lb(b,e,c,n,m)}If(b,t)})}function xo(e,t,n){return{instance:e,listener:t,currentTarget:n}}function Vr(e,t){for(var n=t+"Capture",a=[];e!==null;){var o=e,i=o.stateNode;if(o=o.tag,o!==5&&o!==26&&o!==27||i===null||(o=lo(e,n),o!=null&&a.unshift(xo(e,o,i)),o=lo(e,t),o!=null&&a.push(xo(e,o,i))),e.tag===3)return a;e=e.return}return[]}function Fb(e){if(e===null)return null;do e=e.return;while(e&&e.tag!==5&&e.tag!==27);return e||null}function ic(e,t,n,a,o){for(var i=t._reactName,s=[];n!==null&&n!==a;){var l=n,u=l.alternate,c=l.stateNode;if(l=l.tag,u!==null&&u===a)break;l!==5&&l!==26&&l!==27||c===null||(u=c,o?(c=lo(n,i),c!=null&&s.unshift(xo(n,c,u))):o||(c=lo(n,i),c!=null&&s.push(xo(n,c,u)))),n=n.return}s.length!==0&&e.push({event:t,listeners:s})}var Gb=/\r\n?/g,Vb=/\u0000|\uFFFD/g;function sc(e){return(typeof e=="string"?e:""+e).replace(Gb,`
`).replace(Vb,"")}function Wf(e,t){return t=sc(t),sc(e)===t}function F(e,t,n,a,o,i){switch(n){case"children":typeof a=="string"?t==="body"||t==="textarea"&&a===""||ca(e,a):(typeof a=="number"||typeof a=="bigint")&&t!=="body"&&ca(e,""+a);break;case"className":Po(e,"class",a);break;case"tabIndex":Po(e,"tabindex",a);break;case"dir":case"role":case"viewBox":case"width":case"height":Po(e,n,a);break;case"style":Xc(e,a,i);break;case"data":if(t!=="object"){Po(e,"data",a);break}case"src":case"href":if(a===""&&(t!=="a"||n!=="href")){e.removeAttribute(n);break}if(a==null||typeof a=="function"||typeof a=="symbol"||typeof a=="boolean"){e.removeAttribute(n);break}a=lr(""+a),e.setAttribute(n,a);break;case"action":case"formAction":if(typeof a=="function"){e.setAttribute(n,"javascript:throw new Error('A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().')");break}else typeof i=="function"&&(n==="formAction"?(t!=="input"&&F(e,t,"name",o.name,o,null),F(e,t,"formEncType",o.formEncType,o,null),F(e,t,"formMethod",o.formMethod,o,null),F(e,t,"formTarget",o.formTarget,o,null)):(F(e,t,"encType",o.encType,o,null),F(e,t,"method",o.method,o,null),F(e,t,"target",o.target,o,null)));if(a==null||typeof a=="symbol"||typeof a=="boolean"){e.removeAttribute(n);break}a=lr(""+a),e.setAttribute(n,a);break;case"onClick":a!=null&&(e.onclick=Tt);break;case"onScroll":a!=null&&O("scroll",e);break;case"onScrollEnd":a!=null&&O("scrollend",e);break;case"dangerouslySetInnerHTML":if(a!=null){if(typeof a!="object"||!("__html"in a))throw Error(y(61));if(n=a.__html,n!=null){if(o.children!=null)throw Error(y(60));e.innerHTML=n}}break;case"multiple":e.multiple=a&&typeof a!="function"&&typeof a!="symbol";break;case"muted":e.muted=a&&typeof a!="function"&&typeof a!="symbol";break;case"suppressContentEditableWarning":case"suppressHydrationWarning":case"defaultValue":case"defaultChecked":case"innerHTML":case"ref":break;case"autoFocus":break;case"xlinkHref":if(a==null||typeof a=="function"||typeof a=="boolean"||typeof a=="symbol"){e.removeAttribute("xlink:href");break}n=lr(""+a),e.setAttributeNS("http://www.w3.org/1999/xlink","xlink:href",n);break;case"contentEditable":case"spellCheck":case"draggable":case"value":case"autoReverse":case"externalResourcesRequired":case"focusable":case"preserveAlpha":a!=null&&typeof a!="function"&&typeof a!="symbol"?e.setAttribute(n,""+a):e.removeAttribute(n);break;case"inert":case"allowFullScreen":case"async":case"autoPlay":case"controls":case"default":case"defer":case"disabled":case"disablePictureInPicture":case"disableRemotePlayback":case"formNoValidate":case"hidden":case"loop":case"noModule":case"noValidate":case"open":case"playsInline":case"readOnly":case"required":case"reversed":case"scoped":case"seamless":case"itemScope":a&&typeof a!="function"&&typeof a!="symbol"?e.setAttribute(n,""):e.removeAttribute(n);break;case"capture":case"download":a===!0?e.setAttribute(n,""):a!==!1&&a!=null&&typeof a!="function"&&typeof a!="symbol"?e.setAttribute(n,a):e.removeAttribute(n);break;case"cols":case"rows":case"size":case"span":a!=null&&typeof a!="function"&&typeof a!="symbol"&&!isNaN(a)&&1<=a?e.setAttribute(n,a):e.removeAttribute(n);break;case"rowSpan":case"start":a==null||typeof a=="function"||typeof a=="symbol"||isNaN(a)?e.removeAttribute(n):e.setAttribute(n,a);break;case"popover":O("beforetoggle",e),O("toggle",e),sr(e,"popover",a);break;case"xlinkActuate":bt(e,"http://www.w3.org/1999/xlink","xlink:actuate",a);break;case"xlinkArcrole":bt(e,"http://www.w3.org/1999/xlink","xlink:arcrole",a);break;case"xlinkRole":bt(e,"http://www.w3.org/1999/xlink","xlink:role",a);break;case"xlinkShow":bt(e,"http://www.w3.org/1999/xlink","xlink:show",a);break;case"xlinkTitle":bt(e,"http://www.w3.org/1999/xlink","xlink:title",a);break;case"xlinkType":bt(e,"http://www.w3.org/1999/xlink","xlink:type",a);break;case"xmlBase":bt(e,"http://www.w3.org/XML/1998/namespace","xml:base",a);break;case"xmlLang":bt(e,"http://www.w3.org/XML/1998/namespace","xml:lang",a);break;case"xmlSpace":bt(e,"http://www.w3.org/XML/1998/namespace","xml:space",a);break;case"is":sr(e,"is",a);break;case"innerText":case"textContent":break;default:(!(2<n.length)||n[0]!=="o"&&n[0]!=="O"||n[1]!=="n"&&n[1]!=="N")&&(n=ym.get(n)||n,sr(e,n,a))}}function cl(e,t,n,a,o,i){switch(n){case"style":Xc(e,a,i);break;case"dangerouslySetInnerHTML":if(a!=null){if(typeof a!="object"||!("__html"in a))throw Error(y(61));if(n=a.__html,n!=null){if(o.children!=null)throw Error(y(60));e.innerHTML=n}}break;case"children":typeof a=="string"?ca(e,a):(typeof a=="number"||typeof a=="bigint")&&ca(e,""+a);break;case"onScroll":a!=null&&O("scroll",e);break;case"onScrollEnd":a!=null&&O("scrollend",e);break;case"onClick":a!=null&&(e.onclick=Tt);break;case"suppressContentEditableWarning":case"suppressHydrationWarning":case"innerHTML":case"ref":break;case"innerText":case"textContent":break;default:if(!Fc.hasOwnProperty(n))e:{if(n[0]==="o"&&n[1]==="n"&&(o=n.endsWith("Capture"),t=n.slice(2,o?n.length-7:void 0),i=e[Me]||null,i=i!=null?i[n]:null,typeof i=="function"&&e.removeEventListener(t,i,o),typeof a=="function")){typeof i!="function"&&i!==null&&(n in e?e[n]=null:e.hasAttribute(n)&&e.removeAttribute(n)),e.addEventListener(t,a,o);break e}n in e?e[n]=a:a===!0?e.setAttribute(n,""):sr(e,n,a)}}}function ye(e,t,n){switch(t){case"div":case"span":case"svg":case"path":case"a":case"g":case"p":case"li":break;case"img":O("error",e),O("load",e);var a=!1,o=!1,i;for(i in n)if(n.hasOwnProperty(i)){var s=n[i];if(s!=null)switch(i){case"src":a=!0;break;case"srcSet":o=!0;break;case"children":case"dangerouslySetInnerHTML":throw Error(y(137,t));default:F(e,t,i,s,n,null)}}o&&F(e,t,"srcSet",n.srcSet,n,null),a&&F(e,t,"src",n.src,n,null);return;case"input":O("invalid",e);var l=i=s=o=null,u=null,c=null;for(a in n)if(n.hasOwnProperty(a)){var m=n[a];if(m!=null)switch(a){case"name":o=m;break;case"type":s=m;break;case"checked":u=m;break;case"defaultChecked":c=m;break;case"value":i=m;break;case"defaultValue":l=m;break;case"children":case"dangerouslySetInnerHTML":if(m!=null)throw Error(y(137,t));break;default:F(e,t,a,m,n,null)}}Yc(e,i,l,u,c,s,o,!1);return;case"select":O("invalid",e),a=s=i=null;for(o in n)if(n.hasOwnProperty(o)&&(l=n[o],l!=null))switch(o){case"value":i=l;break;case"defaultValue":s=l;break;case"multiple":a=l;default:F(e,t,o,l,n,null)}t=i,n=s,e.multiple=!!a,t!=null?aa(e,!!a,t,!1):n!=null&&aa(e,!!a,n,!0);return;case"textarea":O("invalid",e),i=o=a=null;for(s in n)if(n.hasOwnProperty(s)&&(l=n[s],l!=null))switch(s){case"value":a=l;break;case"defaultValue":o=l;break;case"children":i=l;break;case"dangerouslySetInnerHTML":if(l!=null)throw Error(y(91));break;default:F(e,t,s,l,n,null)}Pc(e,a,o,i);return;case"option":for(u in n)n.hasOwnProperty(u)&&(a=n[u],a!=null)&&(u==="selected"?e.selected=a&&typeof a!="function"&&typeof a!="symbol":F(e,t,u,a,n,null));return;case"dialog":O("beforetoggle",e),O("toggle",e),O("cancel",e),O("close",e);break;case"iframe":case"object":O("load",e);break;case"video":case"audio":for(a=0;a<bo.length;a++)O(bo[a],e);break;case"image":O("error",e),O("load",e);break;case"details":O("toggle",e);break;case"embed":case"source":case"link":O("error",e),O("load",e);case"area":case"base":case"br":case"col":case"hr":case"keygen":case"meta":case"param":case"track":case"wbr":case"menuitem":for(c in n)if(n.hasOwnProperty(c)&&(a=n[c],a!=null))switch(c){case"children":case"dangerouslySetInnerHTML":throw Error(y(137,t));default:F(e,t,c,a,n,null)}return;default:if(Cl(t)){for(m in n)n.hasOwnProperty(m)&&(a=n[m],a!==void 0&&cl(e,t,m,a,n,void 0));return}}for(l in n)n.hasOwnProperty(l)&&(a=n[l],a!=null&&F(e,t,l,a,n,null))}function Yb(e,t,n,a){switch(t){case"div":case"span":case"svg":case"path":case"a":case"g":case"p":case"li":break;case"input":var o=null,i=null,s=null,l=null,u=null,c=null,m=null;for(h in n){var b=n[h];if(n.hasOwnProperty(h)&&b!=null)switch(h){case"checked":break;case"value":break;case"defaultValue":u=b;default:a.hasOwnProperty(h)||F(e,t,h,null,a,b)}}for(var f in a){var h=a[f];if(b=n[f],a.hasOwnProperty(f)&&(h!=null||b!=null))switch(f){case"type":i=h;break;case"name":o=h;break;case"checked":c=h;break;case"defaultChecked":m=h;break;case"value":s=h;break;case"defaultValue":l=h;break;case"children":case"dangerouslySetInnerHTML":if(h!=null)throw Error(y(137,t));break;default:h!==b&&F(e,t,f,h,a,b)}}Ns(e,s,l,u,c,m,i,o);return;case"select":h=s=l=f=null;for(i in n)if(u=n[i],n.hasOwnProperty(i)&&u!=null)switch(i){case"value":break;case"multiple":h=u;default:a.hasOwnProperty(i)||F(e,t,i,null,a,u)}for(o in a)if(i=a[o],u=n[o],a.hasOwnProperty(o)&&(i!=null||u!=null))switch(o){case"value":f=i;break;case"defaultValue":l=i;break;case"multiple":s=i;default:i!==u&&F(e,t,o,i,a,u)}t=l,n=s,a=h,f!=null?aa(e,!!n,f,!1):!!a!=!!n&&(t!=null?aa(e,!!n,t,!0):aa(e,!!n,n?[]:"",!1));return;case"textarea":h=f=null;for(l in n)if(o=n[l],n.hasOwnProperty(l)&&o!=null&&!a.hasOwnProperty(l))switch(l){case"value":break;case"children":break;default:F(e,t,l,null,a,o)}for(s in a)if(o=a[s],i=n[s],a.hasOwnProperty(s)&&(o!=null||i!=null))switch(s){case"value":f=o;break;case"defaultValue":h=o;break;case"children":break;case"dangerouslySetInnerHTML":if(o!=null)throw Error(y(91));break;default:o!==i&&F(e,t,s,o,a,i)}Kc(e,f,h);return;case"option":for(var w in n)f=n[w],n.hasOwnProperty(w)&&f!=null&&!a.hasOwnProperty(w)&&(w==="selected"?e.selected=!1:F(e,t,w,null,a,f));for(u in a)f=a[u],h=n[u],a.hasOwnProperty(u)&&f!==h&&(f!=null||h!=null)&&(u==="selected"?e.selected=f&&typeof f!="function"&&typeof f!="symbol":F(e,t,u,f,a,h));return;case"img":case"link":case"area":case"base":case"br":case"col":case"embed":case"hr":case"keygen":case"meta":case"param":case"source":case"track":case"wbr":case"menuitem":for(var $ in n)f=n[$],n.hasOwnProperty($)&&f!=null&&!a.hasOwnProperty($)&&F(e,t,$,null,a,f);for(c in a)if(f=a[c],h=n[c],a.hasOwnProperty(c)&&f!==h&&(f!=null||h!=null))switch(c){case"children":case"dangerouslySetInnerHTML":if(f!=null)throw Error(y(137,t));break;default:F(e,t,c,f,a,h)}return;default:if(Cl(t)){for(var B in n)f=n[B],n.hasOwnProperty(B)&&f!==void 0&&!a.hasOwnProperty(B)&&cl(e,t,B,void 0,a,f);for(m in a)f=a[m],h=n[m],!a.hasOwnProperty(m)||f===h||f===void 0&&h===void 0||cl(e,t,m,f,a,h);return}}for(var p in n)f=n[p],n.hasOwnProperty(p)&&f!=null&&!a.hasOwnProperty(p)&&F(e,t,p,null,a,f);for(b in a)f=a[b],h=n[b],!a.hasOwnProperty(b)||f===h||f==null&&h==null||F(e,t,b,f,a,h)}function lc(e){switch(e){case"css":case"script":case"font":case"img":case"image":case"input":case"link":return!0;default:return!1}}function Kb(){if(typeof performance.getEntriesByType=="function"){for(var e=0,t=0,n=performance.getEntriesByType("resource"),a=0;a<n.length;a++){var o=n[a],i=o.transferSize,s=o.initiatorType,l=o.duration;if(i&&l&&lc(s)){for(s=0,l=o.responseEnd,a+=1;a<n.length;a++){var u=n[a],c=u.startTime;if(c>l)break;var m=u.transferSize,b=u.initiatorType;m&&lc(b)&&(u=u.responseEnd,s+=m*(u<l?1:(l-c)/(u-c)))}if(--a,t+=8*(i+s)/(o.duration/1e3),e++,10<e)break}}if(0<e)return t/e/1e6}return navigator.connection&&(e=navigator.connection.downlink,typeof e=="number")?e:5}var pl=null,fl=null;function Yr(e){return e.nodeType===9?e:e.ownerDocument}function uc(e){switch(e){case"http://www.w3.org/2000/svg":return 1;case"http://www.w3.org/1998/Math/MathML":return 2;default:return 0}}function Jf(e,t){if(e===0)switch(t){case"svg":return 1;case"math":return 2;default:return 0}return e===1&&t==="foreignObject"?0:e}function gl(e,t){return e==="textarea"||e==="noscript"||typeof t.children=="string"||typeof t.children=="number"||typeof t.children=="bigint"||typeof t.dangerouslySetInnerHTML=="object"&&t.dangerouslySetInnerHTML!==null&&t.dangerouslySetInnerHTML.__html!=null}var $s=null;function Pb(){var e=window.event;return e&&e.type==="popstate"?e===$s?!1:($s=e,!0):($s=null,!1)}var eg=typeof setTimeout=="function"?setTimeout:void 0,Xb=typeof clearTimeout=="function"?clearTimeout:void 0,dc=typeof Promise=="function"?Promise:void 0,Qb=typeof queueMicrotask=="function"?queueMicrotask:typeof dc<"u"?function(e){return dc.resolve(null).then(e).catch(Ib)}:eg;function Ib(e){setTimeout(function(){throw e})}function cn(e){return e==="head"}function cc(e,t){var n=t,a=0;do{var o=n.nextSibling;if(e.removeChild(n),o&&o.nodeType===8)if(n=o.data,n==="/$"||n==="/&"){if(a===0){e.removeChild(o),va(t);return}a--}else if(n==="$"||n==="$?"||n==="$~"||n==="$!"||n==="&")a++;else if(n==="html")io(e.ownerDocument.documentElement);else if(n==="head"){n=e.ownerDocument.head,io(n);for(var i=n.firstChild;i;){var s=i.nextSibling,l=i.nodeName;i[Eo]||l==="SCRIPT"||l==="STYLE"||l==="LINK"&&i.rel.toLowerCase()==="stylesheet"||n.removeChild(i),i=s}}else n==="body"&&io(e.ownerDocument.body);n=o}while(n);va(t)}function pc(e,t){var n=e;e=0;do{var a=n.nextSibling;if(n.nodeType===1?t?(n._stashedDisplay=n.style.display,n.style.display="none"):(n.style.display=n._stashedDisplay||"",n.getAttribute("style")===""&&n.removeAttribute("style")):n.nodeType===3&&(t?(n._stashedText=n.nodeValue,n.nodeValue=""):n.nodeValue=n._stashedText||""),a&&a.nodeType===8)if(n=a.data,n==="/$"){if(e===0)break;e--}else n!=="$"&&n!=="$?"&&n!=="$~"&&n!=="$!"||e++;n=a}while(n)}function hl(e){var t=e.firstChild;for(t&&t.nodeType===10&&(t=t.nextSibling);t;){var n=t;switch(t=t.nextSibling,n.nodeName){case"HTML":case"HEAD":case"BODY":hl(n),El(n);continue;case"SCRIPT":case"STYLE":continue;case"LINK":if(n.rel.toLowerCase()==="stylesheet")continue}e.removeChild(n)}}function Zb(e,t,n,a){for(;e.nodeType===1;){var o=n;if(e.nodeName.toLowerCase()!==t.toLowerCase()){if(!a&&(e.nodeName!=="INPUT"||e.type!=="hidden"))break}else if(a){if(!e[Eo])switch(t){case"meta":if(!e.hasAttribute("itemprop"))break;return e;case"link":if(i=e.getAttribute("rel"),i==="stylesheet"&&e.hasAttribute("data-precedence"))break;if(i!==o.rel||e.getAttribute("href")!==(o.href==null||o.href===""?null:o.href)||e.getAttribute("crossorigin")!==(o.crossOrigin==null?null:o.crossOrigin)||e.getAttribute("title")!==(o.title==null?null:o.title))break;return e;case"style":if(e.hasAttribute("data-precedence"))break;return e;case"script":if(i=e.getAttribute("src"),(i!==(o.src==null?null:o.src)||e.getAttribute("type")!==(o.type==null?null:o.type)||e.getAttribute("crossorigin")!==(o.crossOrigin==null?null:o.crossOrigin))&&i&&e.hasAttribute("async")&&!e.hasAttribute("itemprop"))break;return e;default:return e}}else if(t==="input"&&e.type==="hidden"){var i=o.name==null?null:""+o.name;if(o.type==="hidden"&&e.getAttribute("name")===i)return e}else return e;if(e=tt(e.nextSibling),e===null)break}return null}function Wb(e,t,n){if(t==="")return null;for(;e.nodeType!==3;)if((e.nodeType!==1||e.nodeName!=="INPUT"||e.type!=="hidden")&&!n||(e=tt(e.nextSibling),e===null))return null;return e}function tg(e,t){for(;e.nodeType!==8;)if((e.nodeType!==1||e.nodeName!=="INPUT"||e.type!=="hidden")&&!t||(e=tt(e.nextSibling),e===null))return null;return e}function ml(e){return e.data==="$?"||e.data==="$~"}function bl(e){return e.data==="$!"||e.data==="$?"&&e.ownerDocument.readyState!=="loading"}function Jb(e,t){var n=e.ownerDocument;if(e.data==="$~")e._reactRetry=t;else if(e.data!=="$?"||n.readyState!=="loading")t();else{var a=function(){t(),n.removeEventListener("DOMContentLoaded",a)};n.addEventListener("DOMContentLoaded",a),e._reactRetry=a}}function tt(e){for(;e!=null;e=e.nextSibling){var t=e.nodeType;if(t===1||t===3)break;if(t===8){if(t=e.data,t==="$"||t==="$!"||t==="$?"||t==="$~"||t==="&"||t==="F!"||t==="F")break;if(t==="/$"||t==="/&")return null}}return e}var xl=null;function fc(e){e=e.nextSibling;for(var t=0;e;){if(e.nodeType===8){var n=e.data;if(n==="/$"||n==="/&"){if(t===0)return tt(e.nextSibling);t--}else n!=="$"&&n!=="$!"&&n!=="$?"&&n!=="$~"&&n!=="&"||t++}e=e.nextSibling}return null}function gc(e){e=e.previousSibling;for(var t=0;e;){if(e.nodeType===8){var n=e.data;if(n==="$"||n==="$!"||n==="$?"||n==="$~"||n==="&"){if(t===0)return e;t--}else n!=="/$"&&n!=="/&"||t++}e=e.previousSibling}return null}function ng(e,t,n){switch(t=Yr(n),e){case"html":if(e=t.documentElement,!e)throw Error(y(452));return e;case"head":if(e=t.head,!e)throw Error(y(453));return e;case"body":if(e=t.body,!e)throw Error(y(454));return e;default:throw Error(y(451))}}function io(e){for(var t=e.attributes;t.length;)e.removeAttributeNode(t[0]);El(e)}var nt=new Map,hc=new Set;function Kr(e){return typeof e.getRootNode=="function"?e.getRootNode():e.nodeType===9?e:e.ownerDocument}var Ht=U.d;U.d={f:ex,r:tx,D:nx,C:ax,L:ox,m:rx,X:sx,S:ix,M:lx};function ex(){var e=Ht.f(),t=ui();return e||t}function tx(e){var t=wa(e);t!==null&&t.tag===5&&t.type==="form"?Xp(t):Ht.r(e)}var Ta=typeof document>"u"?null:document;function ag(e,t,n){var a=Ta;if(a&&typeof t=="string"&&t){var o=Ze(t);o='link[rel="'+e+'"][href="'+o+'"]',typeof n=="string"&&(o+='[crossorigin="'+n+'"]'),hc.has(o)||(hc.add(o),e={rel:e,crossOrigin:n,href:t},a.querySelector(o)===null&&(t=a.createElement("link"),ye(t,"link",e),fe(t),a.head.appendChild(t)))}}function nx(e){Ht.D(e),ag("dns-prefetch",e,null)}function ax(e,t){Ht.C(e,t),ag("preconnect",e,t)}function ox(e,t,n){Ht.L(e,t,n);var a=Ta;if(a&&e&&t){var o='link[rel="preload"][as="'+Ze(t)+'"]';t==="image"&&n&&n.imageSrcSet?(o+='[imagesrcset="'+Ze(n.imageSrcSet)+'"]',typeof n.imageSizes=="string"&&(o+='[imagesizes="'+Ze(n.imageSizes)+'"]')):o+='[href="'+Ze(e)+'"]';var i=o;switch(t){case"style":i=xa(e);break;case"script":i=Ea(e)}nt.has(i)||(e=W({rel:"preload",href:t==="image"&&n&&n.imageSrcSet?void 0:e,as:t},n),nt.set(i,e),a.querySelector(o)!==null||t==="style"&&a.querySelector(_o(i))||t==="script"&&a.querySelector(Mo(i))||(t=a.createElement("link"),ye(t,"link",e),fe(t),a.head.appendChild(t)))}}function rx(e,t){Ht.m(e,t);var n=Ta;if(n&&e){var a=t&&typeof t.as=="string"?t.as:"script",o='link[rel="modulepreload"][as="'+Ze(a)+'"][href="'+Ze(e)+'"]',i=o;switch(a){case"audioworklet":case"paintworklet":case"serviceworker":case"sharedworker":case"worker":case"script":i=Ea(e)}if(!nt.has(i)&&(e=W({rel:"modulepreload",href:e},t),nt.set(i,e),n.querySelector(o)===null)){switch(a){case"audioworklet":case"paintworklet":case"serviceworker":case"sharedworker":case"worker":case"script":if(n.querySelector(Mo(i)))return}a=n.createElement("link"),ye(a,"link",e),fe(a),n.head.appendChild(a)}}}function ix(e,t,n){Ht.S(e,t,n);var a=Ta;if(a&&e){var o=na(a).hoistableStyles,i=xa(e);t=t||"default";var s=o.get(i);if(!s){var l={loading:0,preload:null};if(s=a.querySelector(_o(i)))l.loading=5;else{e=W({rel:"stylesheet",href:e,"data-precedence":t},n),(n=nt.get(i))&&cu(e,n);var u=s=a.createElement("link");fe(u),ye(u,"link",e),u._p=new Promise(function(c,m){u.onload=c,u.onerror=m}),u.addEventListener("load",function(){l.loading|=1}),u.addEventListener("error",function(){l.loading|=2}),l.loading|=4,xr(s,t,a)}s={type:"stylesheet",instance:s,count:1,state:l},o.set(i,s)}}}function sx(e,t){Ht.X(e,t);var n=Ta;if(n&&e){var a=na(n).hoistableScripts,o=Ea(e),i=a.get(o);i||(i=n.querySelector(Mo(o)),i||(e=W({src:e,async:!0},t),(t=nt.get(o))&&pu(e,t),i=n.createElement("script"),fe(i),ye(i,"link",e),n.head.appendChild(i)),i={type:"script",instance:i,count:1,state:null},a.set(o,i))}}function lx(e,t){Ht.M(e,t);var n=Ta;if(n&&e){var a=na(n).hoistableScripts,o=Ea(e),i=a.get(o);i||(i=n.querySelector(Mo(o)),i||(e=W({src:e,async:!0,type:"module"},t),(t=nt.get(o))&&pu(e,t),i=n.createElement("script"),fe(i),ye(i,"link",e),n.head.appendChild(i)),i={type:"script",instance:i,count:1,state:null},a.set(o,i))}}function mc(e,t,n,a){var o=(o=It.current)?Kr(o):null;if(!o)throw Error(y(446));switch(e){case"meta":case"title":return null;case"style":return typeof n.precedence=="string"&&typeof n.href=="string"?(t=xa(n.href),n=na(o).hoistableStyles,a=n.get(t),a||(a={type:"style",instance:null,count:0,state:null},n.set(t,a)),a):{type:"void",instance:null,count:0,state:null};case"link":if(n.rel==="stylesheet"&&typeof n.href=="string"&&typeof n.precedence=="string"){e=xa(n.href);var i=na(o).hoistableStyles,s=i.get(e);if(s||(o=o.ownerDocument||o,s={type:"stylesheet",instance:null,count:0,state:{loading:0,preload:null}},i.set(e,s),(i=o.querySelector(_o(e)))&&!i._p&&(s.instance=i,s.state.loading=5),nt.has(e)||(n={rel:"preload",as:"style",href:n.href,crossOrigin:n.crossOrigin,integrity:n.integrity,media:n.media,hrefLang:n.hrefLang,referrerPolicy:n.referrerPolicy},nt.set(e,n),i||ux(o,e,n,s.state))),t&&a===null)throw Error(y(528,""));return s}if(t&&a!==null)throw Error(y(529,""));return null;case"script":return t=n.async,n=n.src,typeof n=="string"&&t&&typeof t!="function"&&typeof t!="symbol"?(t=Ea(n),n=na(o).hoistableScripts,a=n.get(t),a||(a={type:"script",instance:null,count:0,state:null},n.set(t,a)),a):{type:"void",instance:null,count:0,state:null};default:throw Error(y(444,e))}}function xa(e){return'href="'+Ze(e)+'"'}function _o(e){return'link[rel="stylesheet"]['+e+"]"}function og(e){return W({},e,{"data-precedence":e.precedence,precedence:null})}function ux(e,t,n,a){e.querySelector('link[rel="preload"][as="style"]['+t+"]")?a.loading=1:(t=e.createElement("link"),a.preload=t,t.addEventListener("load",function(){return a.loading|=1}),t.addEventListener("error",function(){return a.loading|=2}),ye(t,"link",n),fe(t),e.head.appendChild(t))}function Ea(e){return'[src="'+Ze(e)+'"]'}function Mo(e){return"script[async]"+e}function bc(e,t,n){if(t.count++,t.instance===null)switch(t.type){case"style":var a=e.querySelector('style[data-href~="'+Ze(n.href)+'"]');if(a)return t.instance=a,fe(a),a;var o=W({},n,{"data-href":n.href,"data-precedence":n.precedence,href:null,precedence:null});return a=(e.ownerDocument||e).createElement("style"),fe(a),ye(a,"style",o),xr(a,n.precedence,e),t.instance=a;case"stylesheet":o=xa(n.href);var i=e.querySelector(_o(o));if(i)return t.state.loading|=4,t.instance=i,fe(i),i;a=og(n),(o=nt.get(o))&&cu(a,o),i=(e.ownerDocument||e).createElement("link"),fe(i);var s=i;return s._p=new Promise(function(l,u){s.onload=l,s.onerror=u}),ye(i,"link",a),t.state.loading|=4,xr(i,n.precedence,e),t.instance=i;case"script":return i=Ea(n.src),(o=e.querySelector(Mo(i)))?(t.instance=o,fe(o),o):(a=n,(o=nt.get(i))&&(a=W({},n),pu(a,o)),e=e.ownerDocument||e,o=e.createElement("script"),fe(o),ye(o,"link",a),e.head.appendChild(o),t.instance=o);case"void":return null;default:throw Error(y(443,t.type))}else t.type==="stylesheet"&&(t.state.loading&4)===0&&(a=t.instance,t.state.loading|=4,xr(a,n.precedence,e));return t.instance}function xr(e,t,n){for(var a=n.querySelectorAll('link[rel="stylesheet"][data-precedence],style[data-precedence]'),o=a.length?a[a.length-1]:null,i=o,s=0;s<a.length;s++){var l=a[s];if(l.dataset.precedence===t)i=l;else if(i!==o)break}i?i.parentNode.insertBefore(e,i.nextSibling):(t=n.nodeType===9?n.head:n,t.insertBefore(e,t.firstChild))}function cu(e,t){e.crossOrigin==null&&(e.crossOrigin=t.crossOrigin),e.referrerPolicy==null&&(e.referrerPolicy=t.referrerPolicy),e.title==null&&(e.title=t.title)}function pu(e,t){e.crossOrigin==null&&(e.crossOrigin=t.crossOrigin),e.referrerPolicy==null&&(e.referrerPolicy=t.referrerPolicy),e.integrity==null&&(e.integrity=t.integrity)}var vr=null;function xc(e,t,n){if(vr===null){var a=new Map,o=vr=new Map;o.set(n,a)}else o=vr,a=o.get(n),a||(a=new Map,o.set(n,a));if(a.has(e))return a;for(a.set(e,null),n=n.getElementsByTagName(e),o=0;o<n.length;o++){var i=n[o];if(!(i[Eo]||i[be]||e==="link"&&i.getAttribute("rel")==="stylesheet")&&i.namespaceURI!=="http://www.w3.org/2000/svg"){var s=i.getAttribute(t)||"";s=e+s;var l=a.get(s);l?l.push(i):a.set(s,[i])}}return a}function vc(e,t,n){e=e.ownerDocument||e,e.head.insertBefore(n,t==="title"?e.querySelector("head > title"):null)}function dx(e,t,n){if(n===1||t.itemProp!=null)return!1;switch(e){case"meta":case"title":return!0;case"style":if(typeof t.precedence!="string"||typeof t.href!="string"||t.href==="")break;return!0;case"link":if(typeof t.rel!="string"||typeof t.href!="string"||t.href===""||t.onLoad||t.onError)break;return t.rel==="stylesheet"?(e=t.disabled,typeof t.precedence=="string"&&e==null):!0;case"script":if(t.async&&typeof t.async!="function"&&typeof t.async!="symbol"&&!t.onLoad&&!t.onError&&t.src&&typeof t.src=="string")return!0}return!1}function rg(e){return!(e.type==="stylesheet"&&(e.state.loading&3)===0)}function cx(e,t,n,a){if(n.type==="stylesheet"&&(typeof a.media!="string"||matchMedia(a.media).matches!==!1)&&(n.state.loading&4)===0){if(n.instance===null){var o=xa(a.href),i=t.querySelector(_o(o));if(i){t=i._p,t!==null&&typeof t=="object"&&typeof t.then=="function"&&(e.count++,e=Pr.bind(e),t.then(e,e)),n.state.loading|=4,n.instance=i,fe(i);return}i=t.ownerDocument||t,a=og(a),(o=nt.get(o))&&cu(a,o),i=i.createElement("link"),fe(i);var s=i;s._p=new Promise(function(l,u){s.onload=l,s.onerror=u}),ye(i,"link",a),n.instance=i}e.stylesheets===null&&(e.stylesheets=new Map),e.stylesheets.set(n,t),(t=n.state.preload)&&(n.state.loading&3)===0&&(e.count++,n=Pr.bind(e),t.addEventListener("load",n),t.addEventListener("error",n))}}var Ts=0;function px(e,t){return e.stylesheets&&e.count===0&&yr(e,e.stylesheets),0<e.count||0<e.imgCount?function(n){var a=setTimeout(function(){if(e.stylesheets&&yr(e,e.stylesheets),e.unsuspend){var i=e.unsuspend;e.unsuspend=null,i()}},6e4+t);0<e.imgBytes&&Ts===0&&(Ts=62500*Kb());var o=setTimeout(function(){if(e.waitingForImages=!1,e.count===0&&(e.stylesheets&&yr(e,e.stylesheets),e.unsuspend)){var i=e.unsuspend;e.unsuspend=null,i()}},(e.imgBytes>Ts?50:800)+t);return e.unsuspend=n,function(){e.unsuspend=null,clearTimeout(a),clearTimeout(o)}}:null}function Pr(){if(this.count--,this.count===0&&(this.imgCount===0||!this.waitingForImages)){if(this.stylesheets)yr(this,this.stylesheets);else if(this.unsuspend){var e=this.unsuspend;this.unsuspend=null,e()}}}var Xr=null;function yr(e,t){e.stylesheets=null,e.unsuspend!==null&&(e.count++,Xr=new Map,t.forEach(fx,e),Xr=null,Pr.call(e))}function fx(e,t){if(!(t.state.loading&4)){var n=Xr.get(e);if(n)var a=n.get(null);else{n=new Map,Xr.set(e,n);for(var o=e.querySelectorAll("link[data-precedence],style[data-precedence]"),i=0;i<o.length;i++){var s=o[i];(s.nodeName==="LINK"||s.getAttribute("media")!=="not all")&&(n.set(s.dataset.precedence,s),a=s)}a&&n.set(null,a)}o=t.instance,s=o.getAttribute("data-precedence"),i=n.get(s)||a,i===a&&n.set(null,o),n.set(s,o),this.count++,a=Pr.bind(this),o.addEventListener("load",a),o.addEventListener("error",a),i?i.parentNode.insertBefore(o,i.nextSibling):(e=e.nodeType===9?e.head:e,e.insertBefore(o,e.firstChild)),t.state.loading|=4}}var vo={$$typeof:$t,Provider:null,Consumer:null,_currentValue:xn,_currentValue2:xn,_threadCount:0};function gx(e,t,n,a,o,i,s,l,u){this.tag=1,this.containerInfo=e,this.pingCache=this.current=this.pendingChildren=null,this.timeoutHandle=-1,this.callbackNode=this.next=this.pendingContext=this.context=this.cancelPendingCommit=null,this.callbackPriority=0,this.expirationTimes=Zi(-1),this.entangledLanes=this.shellSuspendCounter=this.errorRecoveryDisabledLanes=this.expiredLanes=this.warmLanes=this.pingedLanes=this.suspendedLanes=this.pendingLanes=0,this.entanglements=Zi(0),this.hiddenUpdates=Zi(null),this.identifierPrefix=a,this.onUncaughtError=o,this.onCaughtError=i,this.onRecoverableError=s,this.pooledCache=null,this.pooledCacheLanes=0,this.formState=u,this.incompleteTransitions=new Map}function ig(e,t,n,a,o,i,s,l,u,c,m,b){return e=new gx(e,t,n,s,u,c,m,b,l),t=1,i===!0&&(t|=24),i=De(3,null,null,t),e.current=i,i.stateNode=e,t=Ul(),t.refCount++,e.pooledCache=t,t.refCount++,i.memoizedState={element:a,isDehydrated:n,cache:t},ql(i),e}function sg(e){return e?(e=Wn,e):Wn}function lg(e,t,n,a,o,i){o=sg(o),a.context===null?a.context=o:a.pendingContext=o,a=Wt(t),a.payload={element:n},i=i===void 0?null:i,i!==null&&(a.callback=i),n=Jt(e,a,t),n!==null&&(_e(n,e,t),Wa(n,e,t))}function yc(e,t){if(e=e.memoizedState,e!==null&&e.dehydrated!==null){var n=e.retryLane;e.retryLane=n!==0&&n<t?n:t}}function fu(e,t){yc(e,t),(e=e.alternate)&&yc(e,t)}function ug(e){if(e.tag===13||e.tag===31){var t=zn(e,67108864);t!==null&&_e(t,e,67108864),fu(e,67108864)}}function wc(e){if(e.tag===13||e.tag===31){var t=Fe();t=$l(t);var n=zn(e,t);n!==null&&_e(n,e,t),fu(e,t)}}var Qr=!0;function hx(e,t,n,a){var o=T.T;T.T=null;var i=U.p;try{U.p=2,gu(e,t,n,a)}finally{U.p=i,T.T=o}}function mx(e,t,n,a){var o=T.T;T.T=null;var i=U.p;try{U.p=8,gu(e,t,n,a)}finally{U.p=i,T.T=o}}function gu(e,t,n,a){if(Qr){var o=vl(a);if(o===null)ks(e,t,a,Ir,n),Sc(e,a);else if(xx(o,e,t,n,a))a.stopPropagation();else if(Sc(e,a),t&4&&-1<bx.indexOf(e)){for(;o!==null;){var i=wa(o);if(i!==null)switch(i.tag){case 3:if(i=i.stateNode,i.current.memoizedState.isDehydrated){var s=hn(i.pendingLanes);if(s!==0){var l=i;for(l.pendingLanes|=2,l.entangledLanes|=2;s;){var u=1<<31-qe(s);l.entanglements[1]|=u,s&=~u}ft(i),(D&6)===0&&(jr=je()+500,zo(0,!1))}}break;case 31:case 13:l=zn(i,2),l!==null&&_e(l,i,2),ui(),fu(i,2)}if(i=vl(a),i===null&&ks(e,t,a,Ir,n),i===o)break;o=i}o!==null&&a.stopPropagation()}else ks(e,t,a,null,n)}}function vl(e){return e=Al(e),hu(e)}var Ir=null;function hu(e){if(Ir=null,e=Kn(e),e!==null){var t=So(e);if(t===null)e=null;else{var n=t.tag;if(n===13){if(e=Ac(t),e!==null)return e;e=null}else if(n===31){if(e=Oc(t),e!==null)return e;e=null}else if(n===3){if(t.stateNode.current.memoizedState.isDehydrated)return t.tag===3?t.stateNode.containerInfo:null;e=null}else t!==e&&(e=null)}}return Ir=e,null}function dg(e){switch(e){case"beforetoggle":case"cancel":case"click":case"close":case"contextmenu":case"copy":case"cut":case"auxclick":case"dblclick":case"dragend":case"dragstart":case"drop":case"focusin":case"focusout":case"input":case"invalid":case"keydown":case"keypress":case"keyup":case"mousedown":case"mouseup":case"paste":case"pause":case"play":case"pointercancel":case"pointerdown":case"pointerup":case"ratechange":case"reset":case"resize":case"seeked":case"submit":case"toggle":case"touchcancel":case"touchend":case"touchstart":case"volumechange":case"change":case"selectionchange":case"textInput":case"compositionstart":case"compositionend":case"compositionupdate":case"beforeblur":case"afterblur":case"beforeinput":case"blur":case"fullscreenchange":case"focus":case"hashchange":case"popstate":case"select":case"selectstart":return 2;case"drag":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"mousemove":case"mouseout":case"mouseover":case"pointermove":case"pointerout":case"pointerover":case"scroll":case"touchmove":case"wheel":case"mouseenter":case"mouseleave":case"pointerenter":case"pointerleave":return 8;case"message":switch(om()){case Mc:return 2;case Bc:return 8;case Tr:case rm:return 32;case Hc:return 268435456;default:return 32}default:return 32}}var yl=!1,nn=null,an=null,on=null,yo=new Map,wo=new Map,Vt=[],bx="mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset".split(" ");function Sc(e,t){switch(e){case"focusin":case"focusout":nn=null;break;case"dragenter":case"dragleave":an=null;break;case"mouseover":case"mouseout":on=null;break;case"pointerover":case"pointerout":yo.delete(t.pointerId);break;case"gotpointercapture":case"lostpointercapture":wo.delete(t.pointerId)}}function qa(e,t,n,a,o,i){return e===null||e.nativeEvent!==i?(e={blockedOn:t,domEventName:n,eventSystemFlags:a,nativeEvent:i,targetContainers:[o]},t!==null&&(t=wa(t),t!==null&&ug(t)),e):(e.eventSystemFlags|=a,t=e.targetContainers,o!==null&&t.indexOf(o)===-1&&t.push(o),e)}function xx(e,t,n,a,o){switch(t){case"focusin":return nn=qa(nn,e,t,n,a,o),!0;case"dragenter":return an=qa(an,e,t,n,a,o),!0;case"mouseover":return on=qa(on,e,t,n,a,o),!0;case"pointerover":var i=o.pointerId;return yo.set(i,qa(yo.get(i)||null,e,t,n,a,o)),!0;case"gotpointercapture":return i=o.pointerId,wo.set(i,qa(wo.get(i)||null,e,t,n,a,o)),!0}return!1}function cg(e){var t=Kn(e.target);if(t!==null){var n=So(t);if(n!==null){if(t=n.tag,t===13){if(t=Ac(n),t!==null){e.blockedOn=t,rd(e.priority,function(){wc(n)});return}}else if(t===31){if(t=Oc(n),t!==null){e.blockedOn=t,rd(e.priority,function(){wc(n)});return}}else if(t===3&&n.stateNode.current.memoizedState.isDehydrated){e.blockedOn=n.tag===3?n.stateNode.containerInfo:null;return}}}e.blockedOn=null}function wr(e){if(e.blockedOn!==null)return!1;for(var t=e.targetContainers;0<t.length;){var n=vl(e.nativeEvent);if(n===null){n=e.nativeEvent;var a=new n.constructor(n.type,n);Us=a,n.target.dispatchEvent(a),Us=null}else return t=wa(n),t!==null&&ug(t),e.blockedOn=n,!1;t.shift()}return!0}function kc(e,t,n){wr(e)&&n.delete(t)}function vx(){yl=!1,nn!==null&&wr(nn)&&(nn=null),an!==null&&wr(an)&&(an=null),on!==null&&wr(on)&&(on=null),yo.forEach(kc),wo.forEach(kc)}function rr(e,t){e.blockedOn===t&&(e.blockedOn=null,yl||(yl=!0,ce.unstable_scheduleCallback(ce.unstable_NormalPriority,vx)))}var ir=null;function $c(e){ir!==e&&(ir=e,ce.unstable_scheduleCallback(ce.unstable_NormalPriority,function(){ir===e&&(ir=null);for(var t=0;t<e.length;t+=3){var n=e[t],a=e[t+1],o=e[t+2];if(typeof a!="function"){if(hu(a||n)===null)continue;break}var i=wa(n);i!==null&&(e.splice(t,3),t-=3,el(i,{pending:!0,data:o,method:n.method,action:a},a,o))}}))}function va(e){function t(u){return rr(u,e)}nn!==null&&rr(nn,e),an!==null&&rr(an,e),on!==null&&rr(on,e),yo.forEach(t),wo.forEach(t);for(var n=0;n<Vt.length;n++){var a=Vt[n];a.blockedOn===e&&(a.blockedOn=null)}for(;0<Vt.length&&(n=Vt[0],n.blockedOn===null);)cg(n),n.blockedOn===null&&Vt.shift();if(n=(e.ownerDocument||e).$$reactFormReplay,n!=null)for(a=0;a<n.length;a+=3){var o=n[a],i=n[a+1],s=o[Me]||null;if(typeof i=="function")s||$c(n);else if(s){var l=null;if(i&&i.hasAttribute("formAction")){if(o=i,s=i[Me]||null)l=s.formAction;else if(hu(o)!==null)continue}else l=s.action;typeof l=="function"?n[a+1]=l:(n.splice(a,3),a-=3),$c(n)}}}function pg(){function e(i){i.canIntercept&&i.info==="react-transition"&&i.intercept({handler:function(){return new Promise(function(s){return o=s})},focusReset:"manual",scroll:"manual"})}function t(){o!==null&&(o(),o=null),a||setTimeout(n,20)}function n(){if(!a&&!navigation.transition){var i=navigation.currentEntry;i&&i.url!=null&&navigation.navigate(i.url,{state:i.getState(),info:"react-transition",history:"replace"})}}if(typeof navigation=="object"){var a=!1,o=null;return navigation.addEventListener("navigate",e),navigation.addEventListener("navigatesuccess",t),navigation.addEventListener("navigateerror",t),setTimeout(n,100),function(){a=!0,navigation.removeEventListener("navigate",e),navigation.removeEventListener("navigatesuccess",t),navigation.removeEventListener("navigateerror",t),o!==null&&(o(),o=null)}}}function mu(e){this._internalRoot=e}pi.prototype.render=mu.prototype.render=function(e){var t=this._internalRoot;if(t===null)throw Error(y(409));var n=t.current,a=Fe();lg(n,a,e,t,null,null)};pi.prototype.unmount=mu.prototype.unmount=function(){var e=this._internalRoot;if(e!==null){this._internalRoot=null;var t=e.containerInfo;lg(e.current,2,null,e,null,null),ui(),t[ya]=null}};function pi(e){this._internalRoot=e}pi.prototype.unstable_scheduleHydration=function(e){if(e){var t=Lc();e={blockedOn:null,target:e,priority:t};for(var n=0;n<Vt.length&&t!==0&&t<Vt[n].priority;n++);Vt.splice(n,0,e),n===0&&cg(e)}};var Tc=Ec.version;if(Tc!=="19.2.7")throw Error(y(527,Tc,"19.2.7"));U.findDOMNode=function(e){var t=e._reactInternals;if(t===void 0)throw typeof e.render=="function"?Error(y(188)):(e=Object.keys(e).join(","),Error(y(268,e)));return e=Zh(t),e=e!==null?Rc(e):null,e=e===null?null:e.stateNode,e};var yx={bundleType:0,version:"19.2.7",rendererPackageName:"react-dom",currentDispatcherRef:T,reconcilerVersion:"19.2.7"};if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<"u"&&(Fa=__REACT_DEVTOOLS_GLOBAL_HOOK__,!Fa.isDisabled&&Fa.supportsFiber))try{ko=Fa.inject(yx),Le=Fa}catch{}var Fa;fi.createRoot=function(e,t){if(!Cc(e))throw Error(y(299));var n=!1,a="",o=nf,i=af,s=of;return t!=null&&(t.unstable_strictMode===!0&&(n=!0),t.identifierPrefix!==void 0&&(a=t.identifierPrefix),t.onUncaughtError!==void 0&&(o=t.onUncaughtError),t.onCaughtError!==void 0&&(i=t.onCaughtError),t.onRecoverableError!==void 0&&(s=t.onRecoverableError)),t=ig(e,1,!1,null,null,n,a,null,o,i,s,pg),e[ya]=t.current,du(e),new mu(t)};fi.hydrateRoot=function(e,t,n){if(!Cc(e))throw Error(y(299));var a=!1,o="",i=nf,s=af,l=of,u=null;return n!=null&&(n.unstable_strictMode===!0&&(a=!0),n.identifierPrefix!==void 0&&(o=n.identifierPrefix),n.onUncaughtError!==void 0&&(i=n.onUncaughtError),n.onCaughtError!==void 0&&(s=n.onCaughtError),n.onRecoverableError!==void 0&&(l=n.onRecoverableError),n.formState!==void 0&&(u=n.formState)),t=ig(e,1,!0,t,n??null,a,o,u,i,s,l,pg),t.context=sg(null),n=t.current,a=Fe(),a=$l(a),o=Wt(a),o.callback=null,Jt(n,o,a),n=a,t.current.lanes=n,To(t,n),ft(t),e[ya]=t.current,du(e),new pi(t)};fi.version="19.2.7"});var mg=Ye((Kv,hg)=>{"use strict";function gg(){if(!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>"u"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!="function"))try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(gg)}catch(e){console.error(e)}}gg(),hg.exports=fg()});var Yg=Ye(Si=>{"use strict";var ov=Symbol.for("react.transitional.element"),rv=Symbol.for("react.fragment");function Vg(e,t,n){var a=null;if(n!==void 0&&(a=""+n),t.key!==void 0&&(a=""+t.key),"key"in t){n={};for(var o in t)o!=="key"&&(n[o]=t[o])}else n=t;return t=n.ref,{$$typeof:ov,type:e,key:a,ref:t!==void 0?t:null,props:n}}Si.Fragment=rv;Si.jsx=Vg;Si.jsxs=Vg});var he=Ye((by,Kg)=>{"use strict";Kg.exports=Yg()});var hh=Ye(ku=>{"use strict";var Tv=Symbol.for("react.fragment");ku.Fragment=Tv;ku.jsxDEV=void 0});var bh=Ye((x1,mh)=>{"use strict";mh.exports=hh()});var wh=X(mg(),1),Ri=X(mt(),1);function bg(e){var t,n,a="";if(typeof e=="string"||typeof e=="number")a+=e;else if(typeof e=="object")if(Array.isArray(e)){var o=e.length;for(t=0;t<o;t++)e[t]&&(n=bg(e[t]))&&(a&&(a+=" "),a+=n)}else for(n in e)e[n]&&(a&&(a+=" "),a+=n);return a}function gi(){for(var e,t,n=0,a="",o=arguments.length;n<o;n++)(e=arguments[n])&&(t=bg(e))&&(a&&(a+=" "),a+=t);return a}function Ce(...e){return gi(e)}var r={background:"var(--bg, #FBFBFB)",foreground:"var(--text, #403f53)",card:"var(--surface, #fefefe)",cardForeground:"var(--text, #403f53)",surface2:"var(--surface-2, #f4f3f5)",surface3:"var(--surface-3, #ffffff)",glass:"var(--surface-glass, rgba(254,254,254,0.72))",glassStrong:"var(--surface-glass-strong, rgba(254,254,254,0.85))",popover:"var(--surface-3, #ffffff)",popoverForeground:"var(--text, #403f53)",primary:"var(--brand, #9449bc)",primarySoft:"var(--brand-soft, color-mix(in srgb, var(--brand, #9449bc) 10%, var(--surface, #fefefe)))",primarySoftStrong:"var(--brand-soft-strong, color-mix(in srgb, var(--brand, #9449bc) 16%, var(--surface, #fefefe)))",primaryBorder:"var(--brand-border, color-mix(in srgb, var(--brand, #9449bc) 40%, transparent))",primaryForeground:"var(--inverse-text, #FBFBFB)",secondary:"var(--hover, #f4f3f5)",secondaryForeground:"var(--text, #403f53)",muted:"var(--hover, #f4f3f5)",mutedForeground:"var(--text-muted, #676676)",accent:"var(--hover, #f4f3f5)",accentForeground:"var(--text, #403f53)",destructive:"var(--danger, #ba3f3c)",destructiveSoft:"var(--danger-soft, color-mix(in srgb, var(--danger, #ba3f3c) 10%, var(--surface, #fefefe)))",destructiveBorder:"var(--danger-border, color-mix(in srgb, var(--danger, #ba3f3c) 40%, transparent))",success:"var(--success, #21766f)",successSoft:"var(--success-soft, color-mix(in srgb, var(--success, #21766f) 12%, var(--surface, #fefefe)))",successBorder:"var(--success-border, color-mix(in srgb, var(--success, #21766f) 40%, transparent))",warning:"var(--warning, #846701)",warningSoft:"var(--warning-soft, color-mix(in srgb, var(--warning, #846701) 12%, var(--surface, #fefefe)))",warningBorder:"var(--warning-border, color-mix(in srgb, var(--warning, #846701) 40%, transparent))",info:"var(--info, #3f66ba)",infoSoft:"var(--info-soft, color-mix(in srgb, var(--info, #3f66ba) 10%, var(--surface, #fefefe)))",infoBorder:"var(--info-border, color-mix(in srgb, var(--info, #3f66ba) 40%, transparent))",border:"var(--border, rgba(64,63,83,0.08))",borderStrong:"var(--border-strong, rgba(64,63,83,0.14))",input:"var(--border-solid, #e6e6e9)",ring:"var(--ring, color-mix(in srgb, var(--brand, #9449bc) 22%, transparent))",ringBorder:"var(--ring-border, color-mix(in srgb, var(--brand, #9449bc) 50%, transparent))",hoverSubtle:"var(--hover-subtle, rgba(64,63,83,0.04))",textFaint:"var(--text-faint, #6b6a7a)",placeholder:"var(--text-placeholder, #6f6e7d)",inverseBg:"var(--inverse-bg, #403f53)",inverseText:"var(--inverse-text, #FBFBFB)",codeBg:"var(--code-bg, #FBFBFB)",codeText:"var(--code-text, #403f53)",shadowRgb:"var(--shadow-rgb, 64 63 83)",shadow1:"var(--shadow-1, 0 1px 2px rgb(64 63 83 / 0.05))",shadow2:"var(--shadow-2, 0 1px 2px rgb(64 63 83 / 0.04), 0 8px 24px rgb(64 63 83 / 0.07))",shadow3:"var(--shadow-3, 0 4px 12px rgb(64 63 83 / 0.10), 0 16px 48px rgb(64 63 83 / 0.14))",radius:"var(--r-2, 10px)",radiusControl:"var(--r-1, 6px)",radiusBubble:"var(--r-bubble, 18px)",radiusFull:"var(--r-full, 999px)",controlHeight:"var(--ctl-h, 32px)",fontSizeCompact:"var(--fs-2, 12px)",fontSans:"var(--font-sans, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)",fontMono:"var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)"};var wx=["font-family:var(--font-sans)","--font-sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif","--font-mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace"],Sx=[["--bg","bg"],["--text","text"],["--text-muted","textMuted"],["--text-faint","textFaint"],["--text-placeholder","textPlaceholder"],["--surface","surface"],["--surface-2","surface2"],["--surface-3","surface3"],["--surface-glass","surfaceGlass"],["--surface-glass-strong","surfaceGlassStrong"],["--border","border"],["--border-strong","borderStrong"],["--border-solid","borderSolid"],["--hover","hover"],["--hover-subtle","hoverSubtle"],["--inverse-bg","inverseBg"],["--inverse-text","inverseText"],["--code-bg","codeBg"],["--code-text","codeText"],["--inline-code-bg","inlineCodeBg"],["--brand","brand"],["--success","success"],["--danger","danger"],["--warning","warning"],["--info","info"],["--shadow-rgb","shadowRgb"],["--shadow-1","shadow1"],["--shadow-2","shadow2"],["--shadow-3","shadow3"]];function gt(e){let t=[`color-scheme:${e.colorScheme}`];e.colorScheme==="light"&&t.push(...wx);for(let[n,a]of Sx)t.push(`${n}:${e[a]}`);return t.join("; ")}var xg={key:"catppuccin",label:"Catppuccin",light:{colorScheme:"light",bg:"#eff1f5",text:"#4c4f69",textMuted:"#61647b",textFaint:"#66697f",textPlaceholder:"#696c82",surface:"#fbfcfd",surface2:"#f1f2f5",surface3:"#ffffff",surfaceGlass:"rgba(251,252,253,0.72)",surfaceGlassStrong:"rgba(251,252,253,0.85)",border:"rgba(76,79,105,0.08)",borderStrong:"rgba(76,79,105,0.14)",borderSolid:"#dddfe6",hover:"#f1f2f5",hoverSubtle:"rgba(76,79,105,0.04)",inverseBg:"#4c4f69",inverseText:"#eff1f5",codeBg:"#eff1f5",codeText:"#4c4f69",inlineCodeBg:"rgba(76,79,105,0.06)",brand:"#8839ef",success:"#307822",danger:"#cb0e37",warning:"#b2460b",info:"#1c5fe4",shadowRgb:"76 79 105",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.05)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.07)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.10), 0 16px 48px rgb(var(--shadow-rgb) / 0.14)"},dark:{colorScheme:"dark",bg:"#1e1e2e",text:"#cdd6f4",textMuted:"#a3aac4",textFaint:"#a0a6c1",textPlaceholder:"#9aa1bb",surface:"#282839",surface2:"#2f2f41",surface3:"#363749",surfaceGlass:"rgba(40,40,57,0.72)",surfaceGlassStrong:"rgba(40,40,57,0.85)",border:"rgba(205,214,244,0.09)",borderStrong:"rgba(205,214,244,0.16)",borderSolid:"#383a4c",hover:"#2f2f41",hoverSubtle:"rgba(205,214,244,0.05)",inverseBg:"#cdd6f4",inverseText:"#1e1e2e",codeBg:"#1e1e2e",codeText:"#cdd6f4",inlineCodeBg:"rgba(205,214,244,0.08)",brand:"#cba6f7",success:"#a6e3a1",danger:"#f38ba8",warning:"#fab387",info:"#89b4fa",shadowRgb:"0 0 0",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.35)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.30), 0 8px 24px rgb(var(--shadow-rgb) / 0.40)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.45), 0 16px 48px rgb(var(--shadow-rgb) / 0.50)"},syntax:{shikiDark:"catppuccin-mocha",shikiLight:"catppuccin-latte"},terminal:{dark:{background:"#1e1e2e",foreground:"#cdd6f4",cursor:"#f5e0dc",selectionBackground:"#585b70",black:"#45475a",red:"#f38ba8",green:"#a6e3a1",yellow:"#f9e2af",blue:"#89b4fa",magenta:"#f5c2e7",cyan:"#94e2d5",white:"#a6adc8",brightBlack:"#585b70",brightRed:"#f37799",brightGreen:"#89d88b",brightYellow:"#ebd391",brightBlue:"#74a8fc",brightMagenta:"#f2aede",brightCyan:"#6bd7ca",brightWhite:"#bac2de"},light:{background:"#eff1f5",foreground:"#4c4f69",cursor:"#dc8a78",selectionBackground:"#acb0be",black:"#5c5f77",red:"#d20f39",green:"#40a02b",yellow:"#df8e1d",blue:"#1e66f5",magenta:"#ea76cb",cyan:"#179299",white:"#acb0be",brightBlack:"#6c6f85",brightRed:"#de293e",brightGreen:"#49af3d",brightYellow:"#eea02d",brightBlue:"#456eff",brightMagenta:"#fe85d8",brightCyan:"#2d9fa8",brightWhite:"#bcc0cc"}}};var vg={key:"fucory",label:"Fucory",light:{colorScheme:"light",bg:"#fafafa",text:"#18181b",textMuted:"#52525b",textFaint:"#6d6d75",textPlaceholder:"#8a8a93",surface:"#ffffff",surface2:"#f4f4f5",surface3:"#ffffff",surfaceGlass:"rgba(255,255,255,0.72)",surfaceGlassStrong:"rgba(255,255,255,0.85)",border:"rgba(24,24,27,0.08)",borderStrong:"rgba(24,24,27,0.14)",borderSolid:"#e4e4e7",hover:"#f4f4f5",hoverSubtle:"rgba(24,24,27,0.04)",inverseBg:"#18181b",inverseText:"#fafafa",codeBg:"#18181b",codeText:"#f4f4f5",inlineCodeBg:"rgba(24,24,27,0.06)",brand:"#6d56d8",success:"#087461",danger:"#c5343f",warning:"#916000",info:"#2a63c9",shadowRgb:"24 24 27",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.05)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.07)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.10), 0 16px 48px rgb(var(--shadow-rgb) / 0.14)"},dark:{colorScheme:"dark",bg:"#09090b",text:"#f4f4f5",textMuted:"#a1a1aa",textFaint:"#8c8c95",textPlaceholder:"#75757e",surface:"#141417",surface2:"#1b1b20",surface3:"#232329",surfaceGlass:"rgba(20,20,23,0.72)",surfaceGlassStrong:"rgba(20,20,23,0.85)",border:"rgba(255,255,255,0.09)",borderStrong:"rgba(255,255,255,0.16)",borderSolid:"#2a2a30",hover:"#1f1f24",hoverSubtle:"rgba(255,255,255,0.05)",inverseBg:"#f4f4f5",inverseText:"#18181b",codeBg:"#0c0c0e",codeText:"#e4e4e7",inlineCodeBg:"rgba(255,255,255,0.08)",brand:"#8b78e6",success:"#2ec9a8",danger:"#f2555a",warning:"#e0a23a",info:"#6aa5f8",shadowRgb:"0 0 0",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.35)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.30), 0 8px 24px rgb(var(--shadow-rgb) / 0.40)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.45), 0 16px 48px rgb(var(--shadow-rgb) / 0.50)"},syntax:{shikiDark:"github-dark",shikiLight:"github-light"},terminal:{dark:{background:"#07090d",foreground:"#f0f2f5",cursor:"#9ba1ad",selectionBackground:"rgba(123, 147, 217, 0.3)",black:"#11151c",red:"#f05252",green:"#59c173",yellow:"#e3b341",blue:"#7b93d9",magenta:"#9061f9",cyan:"#3bc9db",white:"#f0f2f5",brightBlack:"#11151c",brightRed:"#f05252",brightGreen:"#59c173",brightYellow:"#e3b341",brightBlue:"#7b93d9",brightMagenta:"#9061f9",brightCyan:"#3bc9db",brightWhite:"#f0f2f5"},light:{background:"#fbfcfd",foreground:"#17202a",cursor:"#315d98",selectionBackground:"rgba(49, 93, 152, 0.22)",black:"#1f2933",red:"#c93f3f",green:"#18794e",yellow:"#9a6700",blue:"#315d98",magenta:"#7c3aed",cyan:"#087f8c",white:"#f8fafc",brightBlack:"#1f2933",brightRed:"#c93f3f",brightGreen:"#18794e",brightYellow:"#9a6700",brightBlue:"#315d98",brightMagenta:"#7c3aed",brightCyan:"#087f8c",brightWhite:"#f8fafc"}}};var yg={key:"github",label:"GitHub",light:{colorScheme:"light",bg:"#ffffff",text:"#24292e",textMuted:"#64676b",textFaint:"#686b6f",textPlaceholder:"#6c7073",surface:"#ffffff",surface2:"#f3f3f4",surface3:"#ffffff",surfaceGlass:"rgba(255,255,255,0.72)",surfaceGlassStrong:"rgba(255,255,255,0.85)",border:"rgba(36,41,46,0.08)",borderStrong:"rgba(36,41,46,0.14)",borderSolid:"#e7e7e8",hover:"#f3f3f4",hoverSubtle:"rgba(36,41,46,0.04)",inverseBg:"#24292e",inverseText:"#ffffff",codeBg:"#ffffff",codeText:"#24292e",inlineCodeBg:"rgba(36,41,46,0.06)",brand:"#0969da",success:"#1f7933",danger:"#cb2431",warning:"#83680e",info:"#1a6ac7",shadowRgb:"36 41 46",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.05)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.07)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.10), 0 16px 48px rgb(var(--shadow-rgb) / 0.14)"},dark:{colorScheme:"dark",bg:"#24292e",text:"#e1e4e8",textMuted:"#b4b7bb",textFaint:"#b0b3b8",textPlaceholder:"#aaaeb2",surface:"#2e3338",surface2:"#363b40",surface3:"#3e4247",surfaceGlass:"rgba(46,51,56,0.72)",surfaceGlassStrong:"rgba(46,51,56,0.85)",border:"rgba(225,228,232,0.09)",borderStrong:"rgba(225,228,232,0.16)",borderSolid:"#40454a",hover:"#363b40",hoverSubtle:"rgba(225,228,232,0.05)",inverseBg:"#e1e4e8",inverseText:"#24292e",codeBg:"#24292e",codeText:"#e1e4e8",inlineCodeBg:"rgba(225,228,232,0.08)",brand:"#6eb2ff",success:"#34d058",danger:"#f98f9b",warning:"#ffea7f",info:"#6eb1ff",shadowRgb:"0 0 0",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.35)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.30), 0 8px 24px rgb(var(--shadow-rgb) / 0.40)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.45), 0 16px 48px rgb(var(--shadow-rgb) / 0.50)"},syntax:{shikiDark:"github-dark",shikiLight:"github-light"},terminal:{dark:{background:"#24292e",foreground:"#d1d5da",cursor:"#79b8ff",selectionBackground:"rgba(110,177,255,0.3)",black:"#586069",red:"#ea4a5a",green:"#34d058",yellow:"#ffea7f",blue:"#2188ff",magenta:"#b392f0",cyan:"#39c5cf",white:"#d1d5da",brightBlack:"#959da5",brightRed:"#f97583",brightGreen:"#85e89d",brightYellow:"#ffea7f",brightBlue:"#79b8ff",brightMagenta:"#b392f0",brightCyan:"#56d4dd",brightWhite:"#fafbfc"},light:{background:"#ffffff",foreground:"#586069",cursor:"#005cc5",selectionBackground:"rgba(26,106,199,0.3)",black:"#24292e",red:"#d73a49",green:"#28a745",yellow:"#dbab09",blue:"#0366d6",magenta:"#5a32a3",cyan:"#1b7c83",white:"#6a737d",brightBlack:"#959da5",brightRed:"#cb2431",brightGreen:"#22863a",brightYellow:"#b08800",brightBlue:"#005cc5",brightMagenta:"#5a32a3",brightCyan:"#3192aa",brightWhite:"#d1d5da"}}};var wg={key:"gruvbox",label:"Gruvbox",light:{colorScheme:"light",bg:"#fbf1c7",text:"#3c3836",textMuted:"#6c665a",textFaint:"#6e685c",textPlaceholder:"#716c5f",surface:"#fefcf1",surface2:"#f3f1e7",surface3:"#ffffff",surfaceGlass:"rgba(254,252,241,0.72)",surfaceGlassStrong:"rgba(254,252,241,0.85)",border:"rgba(60,56,54,0.08)",borderStrong:"rgba(60,56,54,0.14)",borderSolid:"#e6ddb7",hover:"#f3f1e7",hoverSubtle:"rgba(60,56,54,0.04)",inverseBg:"#3c3836",inverseText:"#fbf1c7",codeBg:"#fbf1c7",codeText:"#3c3836",inlineCodeBg:"rgba(60,56,54,0.06)",brand:"#8f3f71",success:"#3c3836",danger:"#9d0006",warning:"#876114",info:"#3d7476",shadowRgb:"60 56 54",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.05)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.07)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.10), 0 16px 48px rgb(var(--shadow-rgb) / 0.14)"},dark:{colorScheme:"dark",bg:"#282828",text:"#ebdbb2",textMuted:"#c0b494",textFaint:"#bcb091",textPlaceholder:"#b6ab8d",surface:"#333230",surface2:"#3b3935",surface3:"#42403b",surfaceGlass:"rgba(51,50,48,0.72)",surfaceGlassStrong:"rgba(51,50,48,0.85)",border:"rgba(235,219,178,0.09)",borderStrong:"rgba(235,219,178,0.16)",borderSolid:"#45433d",hover:"#3b3935",hoverSubtle:"rgba(235,219,178,0.05)",inverseBg:"#ebdbb2",inverseText:"#282828",codeBg:"#282828",codeText:"#ebdbb2",inlineCodeBg:"rgba(235,219,178,0.08)",brand:"#d99aab",success:"#ebdbb2",danger:"#fb8c80",warning:"#daa337",info:"#8eb5b7",shadowRgb:"0 0 0",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.35)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.30), 0 8px 24px rgb(var(--shadow-rgb) / 0.40)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.45), 0 16px 48px rgb(var(--shadow-rgb) / 0.50)"},syntax:{shikiDark:"gruvbox-dark-medium",shikiLight:"gruvbox-light-medium"},terminal:{dark:{background:"#282828",foreground:"#ebdbb2",cursor:"#ebdbb2",selectionBackground:"rgba(142,181,183,0.3)",black:"#3c3836",red:"#cc241d",green:"#98971a",yellow:"#d79921",blue:"#458588",magenta:"#b16286",cyan:"#689d6a",white:"#a89984",brightBlack:"#928374",brightRed:"#fb4934",brightGreen:"#b8bb26",brightYellow:"#fabd2f",brightBlue:"#83a598",brightMagenta:"#d3869b",brightCyan:"#8ec07c",brightWhite:"#ebdbb2"},light:{background:"#fbf1c7",foreground:"#3c3836",cursor:"#3c3836",selectionBackground:"rgba(61,116,118,0.3)",black:"#ebdbb2",red:"#cc241d",green:"#98971a",yellow:"#d79921",blue:"#458588",magenta:"#b16286",cyan:"#689d6a",white:"#7c6f64",brightBlack:"#928374",brightRed:"#9d0006",brightGreen:"#79740e",brightYellow:"#b57614",brightBlue:"#076678",brightMagenta:"#8f3f71",brightCyan:"#427b58",brightWhite:"#3c3836"}}};var Sg={key:"night-owl",label:"Night Owl",light:{colorScheme:"light",bg:"#FBFBFB",text:"#403f53",textMuted:"#676676",textFaint:"#6b6a7a",textPlaceholder:"#6f6e7d",surface:"#fefefe",surface2:"#f4f3f5",surface3:"#ffffff",surfaceGlass:"rgba(254,254,254,0.72)",surfaceGlassStrong:"rgba(254,254,254,0.85)",border:"rgba(64,63,83,0.08)",borderStrong:"rgba(64,63,83,0.14)",borderSolid:"#e6e6e9",hover:"#f4f3f5",hoverSubtle:"rgba(64,63,83,0.04)",inverseBg:"#403f53",inverseText:"#FBFBFB",codeBg:"#FBFBFB",codeText:"#403f53",inlineCodeBg:"rgba(64,63,83,0.06)",brand:"#9449bc",success:"#21766f",danger:"#ba3f3c",warning:"#846701",info:"#3f66ba",shadowRgb:"64 63 83",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.05)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.07)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.10), 0 16px 48px rgb(var(--shadow-rgb) / 0.14)"},dark:{colorScheme:"dark",bg:"#011627",text:"#d6deeb",textMuted:"#94a0ae",textFaint:"#909caa",textPlaceholder:"#8b98a6",surface:"#0d2132",surface2:"#15293a",surface3:"#1e3141",surfaceGlass:"rgba(13,33,50,0.72)",surfaceGlassStrong:"rgba(13,33,50,0.85)",border:"rgba(214,222,235,0.09)",borderStrong:"rgba(214,222,235,0.16)",borderSolid:"#213444",hover:"#15293a",hoverSubtle:"rgba(214,222,235,0.05)",inverseBg:"#d6deeb",inverseText:"#011627",codeBg:"#011627",codeText:"#d6deeb",inlineCodeBg:"rgba(214,222,235,0.08)",brand:"#c792ea",success:"#addb67",danger:"#f16f6c",warning:"#ecc48d",info:"#82aaff",shadowRgb:"0 0 0",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.35)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.30), 0 8px 24px rgb(var(--shadow-rgb) / 0.40)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.45), 0 16px 48px rgb(var(--shadow-rgb) / 0.50)"},syntax:{shikiDark:"night-owl",shikiLight:"night-owl-light"},terminal:{dark:{background:"#011627",foreground:"#d6deeb",cursor:"#d6deeb",selectionBackground:"#1b90dd4d",black:"#011627",red:"#EF5350",green:"#22da6e",yellow:"#c5e478",blue:"#82AAFF",magenta:"#C792EA",cyan:"#21c7a8",white:"#ffffff",brightBlack:"#575656",brightRed:"#EF5350",brightGreen:"#22da6e",brightYellow:"#ffeb95",brightBlue:"#82AAFF",brightMagenta:"#C792EA",brightCyan:"#7fdbca",brightWhite:"#ffffff"},light:{background:"#F6F6F6",foreground:"#403f53",cursor:"#403f53",selectionBackground:"rgba(63,102,186,0.3)",black:"#403f53",red:"#de3d3b",green:"#08916a",yellow:"#E0AF02",blue:"#288ed7",magenta:"#d6438a",cyan:"#2AA298",white:"#93A1A1",brightBlack:"#403f53",brightRed:"#de3d3b",brightGreen:"#08916a",brightYellow:"#daaa01",brightBlue:"#288ed7",brightMagenta:"#d6438a",brightCyan:"#2AA298",brightWhite:"#93A1A1"}}};var kg={key:"one",label:"One",light:{colorScheme:"light",bg:"#FAFAFA",text:"#383A42",textMuted:"#67686e",textFaint:"#686a70",textPlaceholder:"#6c6e74",surface:"#fefefe",surface2:"#f3f3f4",surface3:"#ffffff",surfaceGlass:"rgba(254,254,254,0.72)",surfaceGlassStrong:"rgba(254,254,254,0.85)",border:"rgba(56,58,66,0.08)",borderStrong:"rgba(56,58,66,0.14)",borderSolid:"#e5e5e6",hover:"#f3f3f4",hoverSubtle:"rgba(56,58,66,0.04)",inverseBg:"#383A42",inverseText:"#FAFAFA",codeBg:"#FAFAFA",codeText:"#383A42",inlineCodeBg:"rgba(56,58,66,0.06)",brand:"#a626a4",success:"#257943",danger:"#c13442",warning:"#8f5e18",info:"#2b6cb0",shadowRgb:"56 58 66",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.05)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.07)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.10), 0 16px 48px rgb(var(--shadow-rgb) / 0.14)"},dark:{colorScheme:"dark",bg:"#282c34",text:"#abb2bf",textMuted:"#abb2bf",textFaint:"#a7aebb",textPlaceholder:"#a2a9b5",surface:"#2f333c",surface2:"#343941",surface3:"#3a3e47",surfaceGlass:"rgba(47,51,60,0.72)",surfaceGlassStrong:"rgba(47,51,60,0.85)",border:"rgba(171,178,191,0.09)",borderStrong:"rgba(171,178,191,0.16)",borderSolid:"#3c4049",hover:"#343941",hoverSubtle:"rgba(171,178,191,0.05)",inverseBg:"#abb2bf",inverseText:"#282c34",codeBg:"#282c34",codeText:"#abb2bf",inlineCodeBg:"rgba(171,178,191,0.08)",brand:"#d292e3",success:"#64bc9d",danger:"#dd9792",warning:"#d6a475",info:"#b1ab8b",shadowRgb:"0 0 0",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.35)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.30), 0 8px 24px rgb(var(--shadow-rgb) / 0.40)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.45), 0 16px 48px rgb(var(--shadow-rgb) / 0.50)"},syntax:{shikiDark:"one-dark-pro",shikiLight:"one-light"},terminal:{dark:{background:"#282c34",foreground:"#abb2bf",cursor:"#abb2bf",selectionBackground:"#abb2bf30",black:"#3f4451",red:"#e05561",green:"#8cc265",yellow:"#d18f52",blue:"#4aa5f0",magenta:"#c162de",cyan:"#42b3c2",white:"#d7dae0",brightBlack:"#4f5666",brightRed:"#ff616e",brightGreen:"#a5e075",brightYellow:"#f0a45d",brightBlue:"#4dc4ff",brightMagenta:"#de73ff",brightCyan:"#4cd1e0",brightWhite:"#e6e6e6"},light:{background:"#FAFAFA",foreground:"#383A42",cursor:"#383A42",selectionBackground:"rgba(43,108,176,0.3)",black:"#FAFAFA",red:"#c13442",green:"#257943",yellow:"#8f5e18",blue:"#2b6cb0",magenta:"#a626a4",cyan:"#2b6cb0",white:"#383A42",brightBlack:"#a3a4a7",brightRed:"#c13442",brightGreen:"#257943",brightYellow:"#8f5e18",brightBlue:"#2b6cb0",brightMagenta:"#a626a4",brightCyan:"#2b6cb0",brightWhite:"#383A42"}}};var $g={key:"rose-pine",label:"Ros\xE9 Pine",light:{colorScheme:"light",bg:"#faf4ed",text:"#575279",textMuted:"#696486",textFaint:"#6c6788",textPlaceholder:"#6f6a8a",surface:"#fefcfb",surface2:"#f5f3f4",surface3:"#ffffff",surfaceGlass:"rgba(254,252,251,0.72)",surfaceGlassStrong:"rgba(254,252,251,0.85)",border:"rgba(87,82,121,0.08)",borderStrong:"rgba(87,82,121,0.14)",borderSolid:"#e8e2e0",hover:"#f5f3f4",hoverSubtle:"rgba(87,82,121,0.04)",inverseBg:"#575279",inverseText:"#faf4ed",codeBg:"#faf4ed",codeText:"#575279",inlineCodeBg:"rgba(87,82,121,0.06)",brand:"#746289",success:"#417078",danger:"#9c576a",warning:"#8e6021",info:"#417078",shadowRgb:"87 82 121",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.05)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.07)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.10), 0 16px 48px rgb(var(--shadow-rgb) / 0.14)"},dark:{colorScheme:"dark",bg:"#191724",text:"#e0def4",textMuted:"#a4a2b6",textFaint:"#a09eb1",textPlaceholder:"#9c9aad",surface:"#24222f",surface2:"#2c2a38",surface3:"#343240",surfaceGlass:"rgba(36,34,47,0.72)",surfaceGlassStrong:"rgba(36,34,47,0.85)",border:"rgba(224,222,244,0.09)",borderStrong:"rgba(224,222,244,0.16)",borderSolid:"#373543",hover:"#2c2a38",hoverSubtle:"rgba(224,222,244,0.05)",inverseBg:"#e0def4",inverseText:"#191724",codeBg:"#191724",codeText:"#e0def4",inlineCodeBg:"rgba(224,222,244,0.08)",brand:"#c4a7e7",success:"#9ccfd8",danger:"#ed799a",warning:"#f6c177",info:"#9ccfd8",shadowRgb:"0 0 0",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.35)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.30), 0 8px 24px rgb(var(--shadow-rgb) / 0.40)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.45), 0 16px 48px rgb(var(--shadow-rgb) / 0.50)"},syntax:{shikiDark:"rose-pine",shikiLight:"rose-pine-dawn"},terminal:{dark:{background:"#191724",foreground:"#e0def4",cursor:"#6e6a86",selectionBackground:"#6e6a8633",black:"#26233a",red:"#eb6f92",green:"#31748f",yellow:"#f6c177",blue:"#9ccfd8",magenta:"#c4a7e7",cyan:"#ebbcba",white:"#e0def4",brightBlack:"#908caa",brightRed:"#eb6f92",brightGreen:"#31748f",brightYellow:"#f6c177",brightBlue:"#9ccfd8",brightMagenta:"#c4a7e7",brightCyan:"#ebbcba",brightWhite:"#e0def4"},light:{background:"#faf4ed",foreground:"#575279",cursor:"#9893a5",selectionBackground:"#6e6a8614",black:"#f2e9e1",red:"#b4637a",green:"#286983",yellow:"#ea9d34",blue:"#56949f",magenta:"#907aa9",cyan:"#d7827e",white:"#575279",brightBlack:"#797593",brightRed:"#b4637a",brightGreen:"#286983",brightYellow:"#ea9d34",brightBlue:"#56949f",brightMagenta:"#907aa9",brightCyan:"#d7827e",brightWhite:"#575279"}}};var Tg={key:"solarized",label:"Solarized",light:{colorScheme:"light",bg:"#FDF6E3",text:"#657B83",textMuted:"#657b83",textFaint:"#657b83",textPlaceholder:"#657b83",surface:"#fffdf8",surface2:"#f7f6f2",surface3:"#ffffff",surfaceGlass:"rgba(255,253,248,0.72)",surfaceGlassStrong:"rgba(255,253,248,0.85)",border:"rgba(101,123,131,0.08)",borderStrong:"rgba(101,123,131,0.14)",borderSolid:"#ece8d8",hover:"#f7f6f2",hoverSubtle:"rgba(101,123,131,0.04)",inverseBg:"#657B83",inverseText:"#FDF6E3",codeBg:"#FDF6E3",codeText:"#657B83",inlineCodeBg:"rgba(101,123,131,0.06)",brand:"#00629d",success:"#257943",danger:"#c13442",warning:"#8f5e18",info:"#2b6cb0",shadowRgb:"101 123 131",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.05)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px rgb(var(--shadow-rgb) / 0.07)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.10), 0 16px 48px rgb(var(--shadow-rgb) / 0.14)"},dark:{colorScheme:"dark",bg:"#002B36",text:"#839496",textMuted:"#839496",textFaint:"#839496",textPlaceholder:"#839496",surface:"#07313b",surface2:"#0c353f",surface3:"#123943",surfaceGlass:"rgba(7,49,59,0.72)",surfaceGlassStrong:"rgba(7,49,59,0.85)",border:"rgba(131,148,150,0.09)",borderStrong:"rgba(131,148,150,0.16)",borderSolid:"#143b44",hover:"#0c353f",hoverSubtle:"rgba(131,148,150,0.05)",inverseBg:"#839496",inverseText:"#002B36",codeBg:"#002B36",codeText:"#839496",inlineCodeBg:"rgba(131,148,150,0.08)",brand:"#5ca8dc",success:"#67b785",danger:"#ffeaea",warning:"#c89b57",info:"#7ea5cf",shadowRgb:"0 0 0",shadow1:"0 1px 2px rgb(var(--shadow-rgb) / 0.35)",shadow2:"0 1px 2px rgb(var(--shadow-rgb) / 0.30), 0 8px 24px rgb(var(--shadow-rgb) / 0.40)",shadow3:"0 4px 12px rgb(var(--shadow-rgb) / 0.45), 0 16px 48px rgb(var(--shadow-rgb) / 0.50)"},syntax:{shikiDark:"solarized-dark",shikiLight:"solarized-light"},terminal:{dark:{background:"#002B36",foreground:"#839496",cursor:"#839496",selectionBackground:"rgba(126,165,207,0.3)",black:"#073642",red:"#dc322f",green:"#859900",yellow:"#b58900",blue:"#268bd2",magenta:"#d33682",cyan:"#2aa198",white:"#eee8d5",brightBlack:"#002b36",brightRed:"#cb4b16",brightGreen:"#586e75",brightYellow:"#657b83",brightBlue:"#839496",brightMagenta:"#6c71c4",brightCyan:"#93a1a1",brightWhite:"#fdf6e3"},light:{background:"#FDF6E3",foreground:"#657B83",cursor:"#657B83",selectionBackground:"rgba(43,108,176,0.3)",black:"#073642",red:"#dc322f",green:"#859900",yellow:"#b58900",blue:"#268bd2",magenta:"#d33682",cyan:"#2aa198",white:"#eee8d5",brightBlack:"#002b36",brightRed:"#cb4b16",brightGreen:"#586e75",brightYellow:"#657b83",brightBlue:"#839496",brightMagenta:"#6c71c4",brightCyan:"#93a1a1",brightWhite:"#fdf6e3"}}};var Ca="night-owl",Aa={"night-owl":Sg,fucory:vg,one:kg,github:yg,catppuccin:xg,solarized:Tg,gruvbox:wg,"rose-pine":$g};var b0=gt(Aa[Ca].light),x0=gt(Aa[Ca].dark),Eg=["--panel:var(--surface)","--card:var(--surface)","--line:var(--border-solid)","--muted:var(--text-muted)","--primary:var(--brand)","--accent:var(--brand)","--ok:var(--success)","--warn:var(--warning)","--warning-color:var(--warning)","--bad:var(--danger)","--err:var(--danger)","--error:var(--danger)","--blue:var(--info)","--run:var(--brand)","--crit:var(--danger)","--major:var(--warning)","--minor:var(--info)","--nit:var(--muted)","--me:var(--brand-soft)","--ink:var(--inverse-bg)","--brand-soft:color-mix(in srgb, var(--brand) 10%, var(--surface))","--brand-soft-strong:color-mix(in srgb, var(--brand) 16%, var(--surface))","--brand-border:color-mix(in srgb, var(--brand) 40%, transparent)","--success-soft:color-mix(in srgb, var(--success) 12%, var(--surface))","--success-border:color-mix(in srgb, var(--success) 40%, transparent)","--danger-soft:color-mix(in srgb, var(--danger) 10%, var(--surface))","--danger-border:color-mix(in srgb, var(--danger) 40%, transparent)","--warning-soft:color-mix(in srgb, var(--warning) 12%, var(--surface))","--warning-border:color-mix(in srgb, var(--warning) 40%, transparent)","--info-soft:color-mix(in srgb, var(--info) 10%, var(--surface))","--info-border:color-mix(in srgb, var(--info) 40%, transparent)","--ring:color-mix(in srgb, var(--brand) 22%, transparent)","--ring-border:color-mix(in srgb, var(--brand) 50%, transparent)","--sp-1:4px","--sp-2:8px","--sp-3:12px","--sp-4:16px","--sp-5:20px","--sp-6:24px","--sp-7:28px","--sp-8:32px","--fs-1:11px","--fs-2:12px","--fs-3:13px","--fs-4:15px","--fs-5:17px","--fs-6:20px","--fs-7:24px","--lh-tight:1.35","--lh-body:1.5","--r-1:6px","--r-2:10px","--r-3:12px","--r-4:16px","--r-bubble:18px","--r-full:999px","--ctl-h:32px","--ctl-h-sm:28px","--ctl-h-lg:38px"].join("; ");function Cg(e){let t=(o,i)=>`[data-${o}=${e}${i}${e}]`,n=Aa[Ca],a=[`:root { ${gt(n.light)}; ${Eg}; }`,`@media (prefers-color-scheme: dark) { :root:not(${t("theme","light")}) { ${gt(n.dark)}; } }`,`:root${t("theme","dark")} { ${gt(n.dark)}; }`];for(let[o,i]of Object.entries(Aa)){if(o===Ca)continue;let s=t("palette",o);a.push(`:root${s} { ${gt(i.light)}; }`,`@media (prefers-color-scheme: dark) { :root${s}:not(${t("theme","light")}) { ${gt(i.dark)}; } }`,`:root${s}${t("theme","dark")} { ${gt(i.dark)}; }`)}return a}var Bo=`@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-delay:0ms !important; animation-duration:0.001ms !important; animation-iteration-count:1 !important; scroll-behavior:auto !important; transition-delay:0ms !important; transition-duration:0.001ms !important; }
}`;var kx=[...Cg("'"),"* { box-sizing:border-box; }","body { min-width:320px; min-height:100vh; margin:0; background:var(--bg); color:var(--text); font-size:var(--fs-3); line-height:var(--lh-body); font-synthesis:none; text-rendering:optimizeLegibility; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }","::selection { background:color-mix(in srgb, var(--brand) 24%, transparent); }","button,input,textarea,select { font:inherit; }","button { color:inherit; cursor:pointer; }","button:disabled { cursor:not-allowed; }","pre { margin:0; max-width:100%; overflow:auto; }","h1,h2,h3,p { margin:0; }","h1 { color:var(--text); font-size:var(--fs-5); font-weight:650; letter-spacing:-0.01em; line-height:var(--lh-tight); }","h2 { color:var(--text); font-size:var(--fs-4); font-weight:650; letter-spacing:-0.005em; line-height:var(--lh-tight); }","h3 { color:var(--text); font-size:var(--fs-3); font-weight:650; line-height:var(--lh-tight); }","p { color:var(--muted); line-height:1.45; }","code,.mono { font-family:var(--font-mono); }",".muted,.meta { color:var(--muted); }",".top,.topbar { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:var(--sp-4); padding:var(--sp-3) 18px; border-bottom:1px solid var(--border); background:var(--surface-glass-strong); -webkit-backdrop-filter:blur(18px) saturate(180%); backdrop-filter:blur(18px) saturate(180%); }",".title,.title-group { min-width:0; display:flex; align-items:center; gap:10px; }",".toolbar,.actions { display:flex; align-items:center; justify-content:flex-end; gap:var(--sp-2); min-width:0; flex-wrap:wrap; }",".button,.primary,.secondary { min-height:var(--ctl-h); display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:0 var(--sp-3); border:1px solid var(--line); border-radius:var(--r-1); background:var(--panel); color:var(--text); text-decoration:none; cursor:pointer; white-space:nowrap; box-shadow:var(--shadow-1); transition:background-color .12s ease, border-color .12s ease, color .12s ease; }",".button:hover,.primary:hover,.secondary:hover { background:var(--hover); }",".button:active:not(:disabled),.primary:active:not(:disabled),.secondary:active:not(:disabled) { background:color-mix(in srgb, var(--text) 6%, var(--hover)); }",".button:focus-visible,.primary:focus-visible,.secondary:focus-visible,.icon-button:focus-visible,.tab:focus-visible,.run-row:focus-visible,.doc-link:focus-visible,.segmented:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible { outline:none; border-color:var(--ring-border); box-shadow:0 0 0 3px var(--ring); }",".button:disabled,.primary:disabled,.secondary:disabled { cursor:not-allowed; opacity:.45; }",".button.primary,.primary { border-color:var(--brand-border); background:var(--brand-soft); color:var(--brand); font-weight:650; }",".button.primary:hover,.primary:hover { background:var(--brand-soft-strong); }",".button.primary:active:not(:disabled),.primary:active:not(:disabled) { background:color-mix(in srgb, var(--brand) 22%, var(--surface)); }",".button.danger,.danger { border-color:var(--danger-border); color:var(--danger); }",".button.danger:hover,.danger:hover { background:var(--danger-soft); }",".button.danger:active:not(:disabled),.danger:active:not(:disabled) { background:color-mix(in srgb, var(--danger) 16%, var(--surface)); }",".input,.textarea,.prompt,textarea.prompt,input[type='text'],input[type='search'],input[type='number'],select { min-width:0; border:1px solid var(--line); border-radius:var(--r-1); background:var(--panel); color:var(--text); outline:none; }",".input,.prompt,input[type='text'],input[type='search'],input[type='number'],select { min-height:var(--ctl-h); padding:0 10px; }",".textarea,textarea.prompt,textarea.input,textarea { padding:10px var(--sp-3); min-height:88px; resize:vertical; line-height:1.45; }",".input::placeholder,.textarea::placeholder,.prompt::placeholder,textarea::placeholder,input::placeholder { color:var(--text-placeholder); }",".pill,.badge,.chip { display:inline-flex; align-items:center; gap:6px; min-width:0; max-width:100%; min-height:22px; padding:0 10px; border:1px solid var(--border); border-radius:var(--r-full); color:var(--text-muted); font-family:var(--font-mono); font-size:var(--fs-1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }",".pill { border-color:var(--brand-border); background:var(--brand-soft); color:var(--brand); }",".pill.muted,.badge.muted,.chip { border-color:var(--border); background:var(--hover-subtle); color:var(--text-muted); }",".badge { font-family:inherit; font-weight:650; text-transform:uppercase; }",".badge.ok,.badge.finished,.badge.success { color:var(--success); border-color:var(--success-border); background:var(--success-soft); }",".badge.warn,.badge.waiting { color:var(--warning); border-color:var(--warning-border); background:var(--warning-soft); }",".badge.running,.badge.run { color:var(--brand); border-color:var(--brand-border); background:var(--brand-soft); }",".badge.info { color:var(--info); border-color:var(--info-border); background:var(--info-soft); }",".badge.bad,.badge.failed { color:var(--danger); border-color:var(--danger-border); background:var(--danger-soft); }",".badge.cancelled,.badge.canceled,.badge.skipped,.badge.pending,.badge.queued { color:var(--muted); border-color:var(--border); background:var(--hover-subtle); }",".card,.panel,.kpi,.stat,.slot { min-width:0; border:1px solid var(--border); border-radius:var(--r-2); background:var(--surface); box-shadow:var(--shadow-2); }",".card,.panel,.slot { padding:14px; }",".card-head,.panel-title,.section-head { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; }",".section-head,.label,.field label,.field span { color:var(--muted); font-size:var(--fs-1); font-weight:650; text-transform:uppercase; letter-spacing:.05em; }",".field { min-width:0; display:grid; gap:6px; }",".empty { padding:var(--sp-6); color:var(--muted); text-align:center; }",".alert { border:1px solid var(--border); border-radius:var(--r-2); padding:var(--sp-3); background:var(--surface); color:var(--muted); }",".alert.err,.error-text { color:var(--danger); border-color:var(--danger-border); }",".run-row { border-color:var(--border); color:var(--text); transition:border-color .12s ease, background .12s ease; }",".run-row:hover,.run-row.active,.run-row.is-active { background:var(--hover); }",".run-row.active,.run-row.is-active { border-color:var(--brand-border); box-shadow:inset 2px 0 0 var(--brand); }",".table { width:100%; border-collapse:collapse; }",".table th,.table td { padding:var(--sp-2) 10px; border-bottom:1px solid var(--border); text-align:left; vertical-align:top; }",".table th { color:var(--muted); font-size:var(--fs-1); text-transform:uppercase; letter-spacing:.04em; font-weight:650; }",".code,.source,pre.code { display:block; min-width:0; overflow:auto; white-space:pre-wrap; font-family:var(--font-mono); font-size:var(--fs-1); line-height:1.55; color:var(--code-text); background:var(--code-bg); border:1px solid var(--border); border-radius:var(--r-2); padding:10px; }",".plus { color:var(--success); } .minus { color:var(--danger); }",".livelog { overflow:auto; background:var(--code-bg); border:1px solid var(--border); border-radius:var(--r-2); padding:var(--sp-2); font-family:var(--font-mono); font-size:var(--fs-1); line-height:1.55; }",".livelog-line { display:flex; gap:var(--sp-2); padding:2px 0; white-space:pre-wrap; word-break:break-word; }",".livelog-event { color:var(--brand); flex:none; }",".livelog-node { color:var(--warning); flex:none; }",".livelog-detail { color:var(--code-text); min-width:0; }","* { scrollbar-width:thin; scrollbar-color:color-mix(in srgb,var(--text-muted) 35%,transparent) transparent; }","@media (max-width: 760px) { .top,.topbar { align-items:flex-start; flex-direction:column; padding:10px var(--sp-3); } .toolbar,.actions { width:100%; justify-content:flex-start; } .button,.primary,.secondary { min-width:0; } }",Bo].join(`
`),$x=[".workflow-shell { height:100vh; width:100%; max-width:100vw; overflow:hidden; display:grid; grid-template-rows:auto 1fr; background:var(--bg); color:var(--text); }",".workflow-content { min-width:0; min-height:0; overflow:auto; padding:var(--sp-4) 18px; display:grid; align-content:start; gap:14px; }",".workflow-launch { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--sp-2); align-items:start; }",".workflow-dashboard { min-width:0; min-height:0; display:grid; grid-template-columns:minmax(240px,320px) minmax(0,1fr); gap:14px; align-items:start; }",".workflow-runs { display:grid; align-content:start; gap:var(--sp-2); }",".workflow-run-row { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:var(--sp-3); width:100%; padding:10px var(--sp-3); border:1px solid var(--border); border-radius:var(--r-2); background:var(--surface); color:var(--text); text-align:left; cursor:pointer; box-shadow:var(--shadow-1); }",".workflow-run-row:hover,.workflow-run-row.active { background:var(--hover); border-color:var(--brand-border); }",".workflow-run-row.active { box-shadow:inset 2px 0 0 var(--brand), var(--shadow-1); }",".workflow-run-main { min-width:0; display:grid; gap:var(--sp-1); }",".workflow-run-id { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--font-mono); font-size:var(--fs-2); }",".workflow-run-meta { color:var(--muted); font-size:var(--fs-1); }",".workflow-detail { min-width:0; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }",".workflow-detail .panel { display:grid; gap:10px; }",".workflow-tree,.workflow-events { min-height:220px; max-height:52vh; }","@media (max-width: 980px) { .workflow-dashboard,.workflow-detail { grid-template-columns:1fr; } .workflow-tree,.workflow-events { max-height:360px; } }","@media (max-width: 620px) { .workflow-content { padding:var(--sp-3); } .workflow-launch { grid-template-columns:1fr; } .workflow-launch .button { width:100%; } }"].join(`
`),A0=[kx,$x].join(`
`);function hi(e){return(e??"").trim().toLowerCase().replaceAll("_","-")}var Ag={ok:r.success,warn:r.warning,bad:r.destructive,muted:r.mutedForeground,run:r.primary},Og={fixed:"ok",ready:"ok",done:"ok",finished:"ok",continued:"ok",succeeded:"ok",success:"ok",ok:"ok",complete:"ok",completed:"ok",closed:"ok",produced:"ok",broken:"bad",blocked:"bad",failed:"bad",failure:"bad",error:"bad",denied:"bad",cancelled:"muted",canceled:"muted",stale:"bad",orphaned:"bad",running:"run",active:"run",current:"run","in-progress":"run",inprogress:"run",working:"run",retrying:"run",streaming:"run",partial:"warn","missing-tests":"warn",missing:"warn",waiting:"warn","waiting-approval":"warn","waiting-event":"warn","waiting-timer":"warn","waiting-quota":"warn",paused:"warn",recovering:"warn",queued:"muted",pending:"muted",open:"muted",todo:"muted",skipped:"muted"},Y=Object.freeze(Object.fromEntries([...Object.entries(Ag),...Object.entries(Og).map(([e,t])=>[e,Ag[t]])]));function mi(e){let t=hi(e);return t.startsWith("waiting-")?"warn":Og[t]??"muted"}function bi(e){let t=hi(e);return t?{ok:"Complete",success:"Complete",complete:"Complete",completed:"Complete",fixed:"Fixed",ready:"Ready",done:"Done",finished:"Finished",continued:"Continued",succeeded:"Complete",running:"Running",pending:"Pending",queued:"Queued",waiting:"Waiting","waiting-approval":"Waiting for approval","waiting-event":"Waiting for event","waiting-timer":"Waiting on timer","waiting-quota":"Waiting on quota",paused:"Paused",partial:"Partial","missing-tests":"Missing e2e",missing:"Missing",broken:"Broken",blocked:"Blocked",failed:"Failed",failure:"Failed",error:"Error",denied:"Denied",cancelled:"Cancelled",canceled:"Cancelled",skipped:"Skipped",todo:"Todo",open:"Open",closed:"Closed",recovering:"Recovering",stale:"Stale",orphaned:"Orphaned"}[t]??t.split("-").map(a=>a&&`${a[0].toUpperCase()}${a.slice(1)}`).join(" "):"Unknown"}var Xg=X(mt(),1);var xi=`outline:none; border-color:${r.ringBorder}; box-shadow:0 0 0 3px ${r.ring};`;var Rg=`
.sui-msg { display:flex; gap:10px; max-width:100%; }
.sui-msg[data-align='end'] { flex-direction:row-reverse; }
.sui-msg[data-grouped='true'] { margin-top:-10px; }
.sui-msg[data-grouped='true'] .sui-msg-avatar { visibility:hidden; }
.sui-msg-avatar { flex:none; width:28px; height:28px; display:inline-flex; align-items:center; justify-content:center; overflow:hidden; border-radius:${r.radiusFull}; background:${r.secondary}; color:${r.mutedForeground}; font-size:11px; font-weight:650; user-select:none; }
.sui-msg-avatar img { width:100%; height:100%; object-fit:cover; }
.sui-msg-header { display:flex; align-items:baseline; gap:8px; color:${r.mutedForeground}; font-size:11px; font-weight:650; }
.sui-msg-content { min-width:0; flex:1 1 auto; display:flex; flex-direction:column; gap:4px; }
.sui-msg-footer { display:flex; align-items:center; gap:8px; color:${r.mutedForeground}; font-size:11px; }
.sui-msg-actions { display:flex; align-items:center; gap:2px; opacity:0; transition:opacity .12s ease; }
.sui-msg:hover .sui-msg-actions, .sui-msg:focus-within .sui-msg-actions { opacity:1; }
.sui-msg-group { display:flex; flex-direction:column; gap:18px; }

.sui-msg-branch { display:grid; gap:6px; }
.sui-msg-branch-content { min-width:0; }
.sui-msg-branch-selector { display:inline-flex; align-items:center; gap:6px; color:${r.mutedForeground}; }
.sui-msg-branch-button { min-width:22px; min-height:22px; display:inline-flex; align-items:center; justify-content:center; padding:0 4px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:12px; cursor:pointer; }
.sui-msg-branch-button:hover:not(:disabled) { background:${r.secondary}; color:${r.foreground}; }
.sui-msg-branch-button:focus-visible { ${xi} }
.sui-msg-branch-button:disabled { cursor:not-allowed; opacity:.4; }
.sui-msg-branch-page { font-size:11px; font-variant-numeric:tabular-nums; }

.sui-bubble-actions { display:flex; align-items:center; gap:2px; margin-top:6px; }
.sui-bubble-reactions { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-top:6px; }
.sui-bubble-reaction { display:inline-flex; align-items:center; gap:4px; min-height:22px; padding:0 8px; border:1px solid ${r.border}; border-radius:${r.radiusFull}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:11px; cursor:pointer; }
.sui-bubble-reaction:hover { background:${r.secondary}; }
.sui-bubble-reaction:focus-visible { ${xi} }
.sui-bubble-reaction[aria-pressed='true'] { border-color:${r.primaryBorder}; background:${r.primarySoft}; color:${r.primary}; }

.sui-compact-group { border:1px dashed ${r.borderStrong}; border-radius:${r.radius}; background:${r.hoverSubtle}; }
.sui-compact-group-trigger { width:100%; display:flex; align-items:center; gap:8px; min-height:${r.controlHeight}; padding:4px 10px; border:0; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:12px; cursor:pointer; text-align:left; }
.sui-compact-group-trigger:hover { color:${r.foreground}; }
.sui-compact-group-trigger:focus-visible { ${xi} }
.sui-compact-group-chevron { flex:none; font-size:10px; transition:transform .12s ease; }
.sui-compact-group[data-open='true'] .sui-compact-group-chevron { transform:rotate(90deg); }
.sui-compact-group-content { padding:4px 10px 10px; display:grid; gap:8px; }

.sui-convo-checkpoint { display:flex; align-items:center; gap:10px; }
.sui-convo-checkpoint::before, .sui-convo-checkpoint::after { content:""; flex:1 1 0; height:1px; background:${r.border}; }
.sui-convo-checkpoint-body { flex:none; display:inline-flex; align-items:center; gap:8px; max-width:70%; padding:2px 10px; border:1px solid ${r.border}; border-radius:${r.radiusFull}; color:${r.mutedForeground}; font-size:11px; }
.sui-convo-checkpoint-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-convo-checkpoint-time { flex:none; font-variant-numeric:tabular-nums; }
.sui-convo-checkpoint-actions { flex:none; display:inline-flex; align-items:center; gap:4px; }

.sui-msg-scroller-item { min-width:0; content-visibility:auto; contain-intrinsic-size:auto var(--sui-msg-intrinsic, 96px); }
.sui-msg-scroller-button { position:absolute; left:50%; bottom:14px; transform:translateX(-50%); z-index:5; min-width:32px; height:${r.controlHeight}; display:inline-flex; align-items:center; justify-content:center; padding:0 10px; border:1px solid ${r.border}; border-radius:${r.radiusFull}; background:${r.glassStrong}; color:${r.foreground}; font:inherit; font-size:12px; cursor:pointer; box-shadow:0 1px 2px rgb(${r.shadowRgb} / 0.06), 0 8px 24px rgb(${r.shadowRgb} / 0.10); }
.sui-msg-scroller-button[data-target='start'] { bottom:auto; top:14px; }
.sui-msg-scroller-button[data-active='false'] { display:none; }
.sui-msg-scroller-button:hover { background:${r.secondary}; }
.sui-msg-scroller-button:focus-visible { ${xi} }
`;var Ho=`outline:none; border-color:${r.ringBorder}; box-shadow:0 0 0 3px ${r.ring};`,zg=`

.sui-prompt { position:relative; display:grid; gap:8px; width:100%; padding:12px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.foreground}; box-shadow:0 1px 2px rgb(${r.shadowRgb} / 0.04); transition:border-color .15s ease, box-shadow .15s ease; }
.sui-prompt:focus-within { border-color:color-mix(in srgb, ${r.primary} 32%, ${r.border}); box-shadow:0 0 0 4px color-mix(in srgb, ${r.primary} 12%, transparent), 0 1px 2px rgb(${r.shadowRgb} / 0.05); }
.sui-prompt[data-disabled='true'] { opacity:.6; }
.sui-prompt[data-drop-active='true'] { border-color:${r.primaryBorder}; background:${r.primarySoft}; }
.sui-prompt-header { min-width:0; display:flex; align-items:center; gap:8px; }
.sui-prompt-body { min-width:0; display:grid; gap:8px; }
.sui-prompt-attachments { min-width:0; display:flex; flex-wrap:wrap; gap:8px; }
.sui-prompt-textarea { width:100%; min-width:0; min-height:24px; max-height:240px; padding:2px 4px; resize:none; overflow-y:auto; border:0; outline:0; background:transparent; color:${r.foreground}; font:inherit; font-size:16px; line-height:1.5; }
.sui-prompt-textarea::placeholder { color:${r.placeholder}; }
.sui-prompt-textarea:disabled { cursor:not-allowed; opacity:.55; }
.sui-prompt-footer { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; }
.sui-prompt-tools { min-width:0; display:flex; align-items:center; gap:4px; flex:1 1 auto; }
.sui-prompt-button { min-height:28px; display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:0 8px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; user-select:none; }
.sui-prompt-button:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-prompt-button:focus-visible { ${Ho} }
.sui-prompt-button:disabled { cursor:not-allowed; opacity:.45; }
.sui-prompt-submit { width:30px; height:30px; min-height:30px; display:inline-flex; align-items:center; justify-content:center; padding:0; border:1px solid ${r.primary}; border-radius:${r.radiusControl}; background:${r.primary}; color:${r.primaryForeground}; font:inherit; font-size:15px; cursor:pointer; flex:none; }
.sui-prompt-submit:hover:not(:disabled) { background:color-mix(in srgb, ${r.primary} 88%, ${r.foreground}); }
.sui-prompt-submit:focus-visible { ${Ho} }
.sui-prompt-submit:disabled { cursor:not-allowed; opacity:.45; }
.sui-prompt-submit[data-status='error'] { border-color:${r.destructiveBorder}; background:${r.destructiveSoft}; color:${r.destructive}; }
.sui-prompt-stop { width:30px; height:30px; min-height:30px; display:inline-flex; align-items:center; justify-content:center; padding:0; border:1px solid ${r.input}; border-radius:${r.radiusControl}; background:${r.card}; color:${r.foreground}; font:inherit; cursor:pointer; flex:none; }
.sui-prompt-stop:hover { background:${r.secondary}; }
.sui-prompt-stop:focus-visible { ${Ho} }
.sui-prompt-action-menu { position:relative; display:inline-flex; }
.sui-prompt-action-menu-content { position:absolute; bottom:calc(100% + 6px); left:0; z-index:50; min-width:180px; display:grid; gap:2px; padding:4px; border:1px solid ${r.border}; border-radius:${r.radiusControl}; background:${r.popover}; color:${r.popoverForeground}; box-shadow:0 4px 12px rgb(${r.shadowRgb} / 0.10), 0 16px 48px rgb(${r.shadowRgb} / 0.16); }
.sui-prompt-action-menu-item { display:flex; align-items:center; gap:8px; width:100%; min-height:30px; padding:4px 8px; border:0; border-radius:${r.radiusControl}; background:transparent; color:${r.foreground}; font:inherit; font-size:13px; text-align:left; cursor:pointer; }
.sui-prompt-action-menu-item:hover, .sui-prompt-action-menu-item[data-highlighted='true'] { background:${r.secondary}; }
.sui-prompt-action-menu-item:focus-visible { ${Ho} }

.sui-attachment-group { min-width:0; display:flex; flex-wrap:wrap; gap:8px; }
.sui-attachment-trigger { display:contents; padding:0; border:0; background:transparent; font:inherit; text-align:left; cursor:pointer; }
.sui-attachment-media { width:48px; height:48px; display:grid; place-items:center; overflow:hidden; border-radius:${r.radiusControl}; background:${r.secondary}; color:${r.mutedForeground}; flex:none; }
.sui-attachment-media img { width:100%; height:100%; object-fit:cover; }
.sui-attachment-content { min-width:0; display:grid; gap:2px; }
.sui-attachment-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:${r.fontSizeCompact}; font-weight:650; }
.sui-attachment-description { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${r.mutedForeground}; font-size:11px; }
.sui-attachment-actions { display:flex; align-items:center; gap:2px; }
.sui-attachment-action { min-width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center; gap:4px; padding:0 6px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:12px; cursor:pointer; }
.sui-attachment-action:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-attachment-action:focus-visible { ${Ho} }
.sui-attachment-action:disabled { cursor:not-allowed; opacity:.45; }
.sui-attachment-preview { width:100%; max-width:240px; overflow:hidden; border:1px solid ${r.border}; border-radius:${r.radiusControl}; background:${r.secondary}; }
.sui-attachment-preview img { display:block; width:100%; height:auto; object-fit:cover; }
.sui-attachment-preview-tile { display:grid; place-items:center; min-height:64px; padding:8px; color:${r.mutedForeground}; font-family:${r.fontMono}; font-size:11px; font-weight:650; }
.sui-attachment[data-state='error'] .sui-attachment-title, .sui-attachment[data-state='error'] .sui-attachment-description { color:${r.destructive}; }
`;var _g=`
.sui-reasoning-summary { min-width:0; display:grid; gap:4px; }
.sui-reasoning-summary-label { color:${r.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-reasoning-summary-label[data-streaming='true'] { background:linear-gradient(90deg, ${r.mutedForeground} 35%, ${r.foreground} 50%, ${r.mutedForeground} 65%); background-size:200% 100%; background-clip:text; -webkit-background-clip:text; color:transparent; animation:sui-shimmer-sweep 2s linear infinite; }
.sui-reasoning-summary-text { min-width:0; color:${r.mutedForeground}; font-size:13px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; }

.sui-cot-step-trigger { grid-column:2; min-width:0; display:flex; align-items:center; gap:6px; padding:0; border:0; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; border-radius:${r.radiusControl}; }
.sui-cot-step-trigger:focus-visible { outline:none; box-shadow:0 0 0 3px ${r.ring}; }
.sui-cot-step-icon { flex:none; display:inline-flex; align-items:center; color:${r.mutedForeground}; }

.sui-toolcall-duration { flex:none; color:${r.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-toolcall-header .sui-toolcall-trigger { width:100%; }
.sui-toolcall-section-title[data-shimmer='true'] { background:linear-gradient(90deg, ${r.mutedForeground} 35%, ${r.foreground} 50%, ${r.mutedForeground} 65%); background-size:200% 100%; background-clip:text; -webkit-background-clip:text; color:transparent; animation:sui-shimmer-sweep 2s linear infinite; }
.sui-toolcall-pre[data-partial='true'] { opacity:.72; }
.sui-toolcall-part { min-width:0; }
.sui-toolcall-part-image { display:block; max-width:100%; height:auto; border:1px solid ${r.borderStrong}; border-radius:${r.radiusControl}; }
.sui-toolcall-error-box { min-width:0; padding:10px 12px; border:1px solid ${r.destructiveBorder}; border-radius:${r.radiusControl}; background:${r.destructiveSoft}; color:${r.destructive}; font-size:12px; line-height:1.5; overflow-wrap:anywhere; }

.sui-codeblock-group { margin:8px 0; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; overflow:hidden; }
.sui-codeblock-group .sui-codeblock { margin:0; border-radius:0; }
.sui-codeblock-group-header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 8px; border-bottom:1px solid ${r.border}; background:${r.surface2}; }
.sui-codeblock-filename { display:inline-flex; align-items:center; gap:6px; min-width:0; font-family:${r.fontMono}; font-size:11px; color:${r.mutedForeground}; }
.sui-codeblock-tabs { display:inline-flex; align-items:center; gap:2px; min-width:0; }
.sui-codeblock-tab { min-height:24px; padding:0 8px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:11px; font-family:${r.fontMono}; cursor:pointer; }
.sui-codeblock-tab:hover { background:${r.hoverSubtle}; color:${r.foreground}; }
.sui-codeblock-tab:focus-visible { outline:none; box-shadow:0 0 0 3px ${r.ring}; }
.sui-codeblock-tab[aria-selected='true'] { border-color:${r.borderStrong}; background:${r.card}; color:${r.foreground}; }
`;var bu=`outline:none; border-color:${r.ringBorder}; box-shadow:0 0 0 3px ${r.ring};`,Mg=`
.sui-plan-description { min-width:0; padding:0 10px 8px; color:${r.mutedForeground}; font-size:${r.fontSizeCompact}; line-height:1.45; }
.sui-plan-content { min-width:0; padding:0 10px 10px; }
.sui-plan-content .sui-plan-steps, .sui-plan-content > ol { margin:0; padding:0; list-style:none; }
.sui-plan-action { min-height:24px; padding:2px 8px; border:1px solid ${r.border}; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:11px; cursor:pointer; }
.sui-plan-action:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-plan-action:focus-visible { ${bu} }
.sui-plan-footer { min-width:0; display:flex; align-items:center; gap:8px; padding:8px 10px; border-top:1px solid ${r.border}; color:${r.mutedForeground}; font-size:${r.fontSizeCompact}; }

.sui-agenttask { min-width:0; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; overflow:hidden; }
.sui-agenttask-trigger { min-width:0; min-height:${r.controlHeight}; width:100%; display:flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.foreground}; font:inherit; text-align:left; cursor:pointer; }
.sui-agenttask-trigger:hover { background:${r.secondary}; }
.sui-agenttask-trigger:focus-visible { ${bu} }
.sui-agenttask-chevron { display:inline-flex; align-items:center; justify-content:center; width:12px; flex:none; color:${r.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-agenttask-trigger[aria-expanded='true'] .sui-agenttask-chevron { transform:rotate(90deg); }
.sui-agenttask-title { min-width:0; flex:1 1 auto; font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-agenttask-content { min-width:0; padding:6px 10px 10px; border-top:1px solid ${r.border}; }
.sui-agenttask-group { min-width:0; display:grid; gap:6px; }

.sui-queue { min-width:0; display:grid; gap:8px; }
.sui-queue-section { min-width:0; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; overflow:hidden; }
.sui-queue-section-trigger { min-width:0; min-height:${r.controlHeight}; width:100%; display:flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.foreground}; font:inherit; text-align:left; cursor:pointer; }
.sui-queue-section-trigger:hover { background:${r.secondary}; }
.sui-queue-section-trigger:focus-visible { ${bu} }
.sui-queue-section-chevron { display:inline-flex; align-items:center; justify-content:center; width:12px; flex:none; color:${r.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-queue-section-trigger[aria-expanded='true'] .sui-queue-section-chevron { transform:rotate(90deg); }
.sui-queue-section-label { min-width:0; display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:650; }
.sui-queue-section-icon { display:inline-flex; align-items:center; flex:none; color:${r.mutedForeground}; }
.sui-queue-section-count { flex:none; padding:0 6px; border-radius:${r.radiusFull}; background:${r.hoverSubtle}; color:${r.mutedForeground}; font-size:10px; font-variant-numeric:tabular-nums; line-height:16px; }
.sui-queue-section-content { min-width:0; border-top:1px solid ${r.border}; }
.sui-queue-list { min-width:0; margin:0; padding:4px; list-style:none; display:grid; gap:2px; }
.sui-queue-item { min-width:0; display:grid; grid-template-columns:14px minmax(0, 1fr); column-gap:8px; padding:6px 8px; border-radius:${r.radiusControl}; }
.sui-queue-item:hover { background:${r.hoverSubtle}; }
.sui-queue-item-indicator { display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; margin-top:1px; border-radius:${r.radiusFull}; border:1px solid ${r.borderStrong}; color:transparent; font-size:10px; line-height:1; }
.sui-queue-item[data-status-class='ok'] .sui-queue-item-indicator, .sui-queue-item-indicator[data-status-class='ok'] { border-color:${r.successBorder}; background:${r.successSoft}; color:${Y.ok}; }
.sui-queue-item[data-status-class='run'] .sui-queue-item-indicator, .sui-queue-item-indicator[data-status-class='run'] { border-color:${r.primaryBorder}; background:${r.primarySoft}; color:${Y.run}; }
.sui-queue-item[data-status-class='warn'] .sui-queue-item-indicator, .sui-queue-item-indicator[data-status-class='warn'] { border-color:${r.warningBorder}; background:${r.warningSoft}; color:${Y.warn}; }
.sui-queue-item[data-status-class='bad'] .sui-queue-item-indicator, .sui-queue-item-indicator[data-status-class='bad'] { border-color:${r.destructiveBorder}; background:${r.destructiveSoft}; color:${Y.bad}; }
.sui-queue-item-content { min-width:0; grid-column:2; font-size:${r.fontSizeCompact}; line-height:1.45; overflow-wrap:anywhere; }
.sui-queue-item-content[data-completed='true'] { color:${r.mutedForeground}; text-decoration:line-through; }
.sui-queue-item-description { min-width:0; grid-column:2; margin-top:2px; color:${r.mutedForeground}; font-size:11px; line-height:1.45; overflow-wrap:anywhere; }

.sui-activity-timeline { min-width:0; margin:0; padding:0; list-style:none; display:grid; gap:0; }
.sui-activity-item { position:relative; min-width:0; display:flex; align-items:flex-start; gap:10px; padding:6px 0 6px 2px; }
.sui-activity-item + .sui-activity-item { border-top:1px solid ${r.border}; }
.sui-activity-marker { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; margin-top:1px; flex:none; border-radius:${r.radiusFull}; border:1px solid ${r.border}; background:${r.surface2}; color:${r.mutedForeground}; font-size:10px; line-height:1; }
.sui-activity-item[data-status-class='ok'] .sui-activity-marker { border-color:${r.successBorder}; background:${r.successSoft}; color:${Y.ok}; }
.sui-activity-item[data-status-class='run'] .sui-activity-marker { border-color:${r.primaryBorder}; background:${r.primarySoft}; color:${Y.run}; }
.sui-activity-item[data-status-class='warn'] .sui-activity-marker { border-color:${r.warningBorder}; background:${r.warningSoft}; color:${Y.warn}; }
.sui-activity-item[data-status-class='bad'] .sui-activity-marker { border-color:${r.destructiveBorder}; background:${r.destructiveSoft}; color:${Y.bad}; }
.sui-activity-body { min-width:0; flex:1 1 auto; display:grid; gap:2px; }
.sui-activity-title { min-width:0; font-size:${r.fontSizeCompact}; line-height:1.45; color:${r.foreground}; overflow-wrap:anywhere; }
.sui-activity-actor { color:${r.mutedForeground}; font-size:11px; }
.sui-activity-time { color:${r.textFaint}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-activity-detail { min-width:0; margin-top:2px; padding:8px 10px; border-radius:${r.radiusControl}; background:${r.surface2}; color:${r.mutedForeground}; font-size:${r.fontSizeCompact}; line-height:1.45; }
.sui-activity-group { min-width:0; padding:6px 0 6px 2px; }
.sui-activity-group + .sui-activity-item, .sui-activity-item + .sui-activity-group, .sui-activity-group + .sui-activity-group { border-top:1px solid ${r.border}; }
.sui-activity-group-label { color:${r.mutedForeground}; font-size:11px; font-weight:650; letter-spacing:0.02em; text-transform:uppercase; }
.sui-activity-group-items { min-width:0; margin:4px 0 0; padding:0; list-style:none; display:grid; gap:0; }

.sui-taskitem-file-icon { display:inline-flex; align-items:center; margin-right:3px; color:${r.mutedForeground}; }
`;var Oa=`outline:none; border-color:${r.ringBorder}; box-shadow:0 0 0 3px ${r.ring};`,Bg=`
.sui-confirm { min-width:0; display:grid; align-content:start; gap:8px; padding:12px 14px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; font-size:13px; }
.sui-confirm[data-state='requested'], .sui-confirm[data-state='failed-submission'] { border-color:${r.warningBorder}; background:${r.warningSoft}; }
.sui-confirm[data-state='approved'] { border-color:${r.successBorder}; background:${r.successSoft}; }
.sui-confirm[data-state='denied'] { border-color:${r.destructiveBorder}; background:${r.destructiveSoft}; }
.sui-confirm[data-state='expired'], .sui-confirm[data-state='unavailable'] { color:${r.mutedForeground}; }
.sui-confirm:focus-visible { ${Oa} }
.sui-confirm-title { min-width:0; font-size:13px; font-weight:650; }
.sui-confirm-request { min-width:0; display:grid; align-content:start; gap:6px; }
.sui-confirm-accepted { min-width:0; display:flex; align-items:center; gap:6px; color:${r.success}; font-weight:650; }
.sui-confirm-rejected { min-width:0; display:flex; align-items:center; gap:6px; color:${r.destructive}; font-weight:650; }
.sui-confirm-note { min-width:0; color:${r.mutedForeground}; font-size:12px; }
.sui-confirm-failure { color:${r.destructive}; }
.sui-confirm-actions { display:flex; align-items:center; gap:8px; min-width:0; }
.sui-confirm-deny { display:grid; gap:8px; min-width:0; padding:10px; border:1px solid ${r.destructiveBorder}; border-radius:${r.radiusControl}; background:${r.destructiveSoft}; color:${r.foreground}; font-weight:650; }
.sui-confirm-action:focus-visible { ${Oa} }

.sui-approval-card { min-width:0; display:grid; align-content:start; gap:10px; padding:14px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; font-size:13px; }
.sui-approval-header { display:flex; align-items:center; gap:8px; min-width:0; }
.sui-approval-title { min-width:0; flex:1; font-size:13px; font-weight:650; }
.sui-approval-summary { min-width:0; color:${r.mutedForeground}; }
.sui-approval-risk { flex:none; display:inline-flex; align-items:center; gap:4px; min-height:22px; padding:0 8px; border-radius:${r.radiusFull}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-approval-risk[data-level='low'] { border:1px solid ${r.infoBorder}; background:${r.infoSoft}; color:${r.info}; }
.sui-approval-risk[data-level='medium'] { border:1px solid ${r.warningBorder}; background:${r.warningSoft}; color:${r.warning}; }
.sui-approval-risk[data-level='high'] { border:1px solid ${r.warningBorder}; background:color-mix(in srgb, ${r.warning} 22%, ${r.card}); color:${r.warning}; }
.sui-approval-risk[data-level='critical'] { border:1px solid ${r.destructiveBorder}; background:${r.destructiveSoft}; color:${r.destructive}; }
.sui-approval-actions-list { min-width:0; margin:0; padding:0 0 0 18px; display:grid; gap:4px; }
.sui-approval-resources { min-width:0; display:grid; gap:4px; }
.sui-approval-resource { display:flex; align-items:center; gap:6px; min-width:0; font-family:${r.fontMono}; font-size:11px; color:${r.mutedForeground}; }
.sui-approval-resource a { color:${r.primary}; text-decoration:none; }
.sui-approval-resource a:hover { text-decoration:underline; }
.sui-approval-resource a:focus-visible { ${Oa} }
.sui-approval-resource-kind { flex:none; padding:2px 6px; border:1px solid ${r.border}; border-radius:${r.radiusFull}; background:${r.surface2}; font-size:10px; text-transform:uppercase; letter-spacing:.05em; }
.sui-approval-note { min-width:0; display:grid; gap:4px; }
.sui-approval-note-label { font-size:12px; font-weight:650; color:${r.mutedForeground}; }
.sui-approval-note-input { min-width:0; width:100%; min-height:56px; padding:6px 8px; border:1px solid ${r.input}; border-radius:${r.radiusControl}; background:${r.card}; color:${r.foreground}; font:inherit; font-size:13px; resize:vertical; }
.sui-approval-note-input:focus-visible { ${Oa} }
.sui-approval-note-input[readonly] { background:${r.surface2}; color:${r.mutedForeground}; }

.sui-checkpoint { min-width:0; display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:6px 10px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; font-size:13px; }
.sui-checkpoint[data-current='true'] { border-color:${r.primaryBorder}; background:${r.primarySoft}; }
.sui-checkpoint-icon { flex:none; display:inline-flex; align-items:center; color:${r.mutedForeground}; }
.sui-checkpoint[data-current='true'] .sui-checkpoint-icon { color:${r.primary}; }
.sui-checkpoint-label { min-width:0; flex:1; font-weight:650; }
.sui-checkpoint-metadata { flex:none; display:flex; align-items:center; gap:8px; color:${r.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-checkpoint-trigger:focus-visible { ${Oa} }
.sui-checkpoint-actions { flex:none; display:flex; align-items:center; gap:4px; }
.sui-checkpoint-action:focus-visible { ${Oa} }
.sui-checkpoint-error { flex-basis:100%; min-width:0; color:${r.destructive}; font-size:12px; }
`;var vi=`outline:none; border-color:${r.ringBorder}; box-shadow:0 0 0 3px ${r.ring};`,Hg=`
.sui-sources-content { display:grid; gap:6px; margin:4px 0 0; padding:8px 8px 8px 28px; border-left:1px solid ${r.border}; list-style:decimal; }
.sui-sources-rich { display:flex; align-items:flex-start; gap:6px; text-decoration:none; color:${r.foreground}; }
.sui-sources-rich:hover { text-decoration:none; }
.sui-sources-favicon { width:16px; height:16px; flex:none; margin-top:1px; border-radius:4px; }
.sui-sources-favicon-fallback { width:16px; height:16px; flex:none; margin-top:1px; display:inline-flex; align-items:center; justify-content:center; border-radius:4px; background:${r.secondary}; color:${r.mutedForeground}; font-size:10px; font-weight:650; text-transform:uppercase; }
.sui-sources-body { min-width:0; display:grid; gap:1px; }
.sui-sources-title { color:${r.primary}; overflow-wrap:anywhere; }
.sui-sources-domain { color:${r.textFaint}; font-size:11px; overflow-wrap:anywhere; }
.sui-sources-excerpt { color:${r.mutedForeground}; font-size:11px; overflow-wrap:anywhere; }
.sui-citation-content { display:block; margin:4px 0; padding:8px; border:1px solid ${r.border}; border-radius:${r.radiusControl}; background:${r.card}; color:${r.foreground}; font-size:12px; font-weight:400; line-height:1.4; }
.sui-citation-card { min-width:0; display:grid; gap:6px; }
.sui-citation-card-header { display:flex; align-items:center; gap:6px; min-width:0; }
.sui-citation-favicon { width:16px; height:16px; flex:none; border-radius:4px; }
.sui-citation-favicon-fallback { width:16px; height:16px; flex:none; display:inline-flex; align-items:center; justify-content:center; border-radius:4px; background:${r.secondary}; color:${r.mutedForeground}; font-size:10px; font-weight:650; text-transform:uppercase; }
.sui-citation-card-title { min-width:0; font-weight:650; color:${r.foreground}; overflow-wrap:anywhere; }
.sui-citation-card-link { color:${r.primary}; text-decoration:underline; text-underline-offset:2px; overflow-wrap:anywhere; }
.sui-citation-card-link:hover { text-decoration-thickness:2px; }
.sui-citation-card-link:focus-visible { ${vi} }
.sui-citation-card-domain { flex:none; color:${r.textFaint}; font-size:11px; overflow-wrap:anywhere; }
.sui-citation-card-excerpt { color:${r.mutedForeground}; overflow-wrap:anywhere; }
.sui-citation-carousel { display:grid; gap:6px; }
.sui-citation-carousel-nav { display:flex; align-items:center; gap:6px; }
.sui-citation-carousel-button { min-width:24px; min-height:24px; display:inline-flex; align-items:center; justify-content:center; padding:2px 6px; border:1px solid ${r.border}; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:12px; line-height:1; cursor:pointer; }
.sui-citation-carousel-button:hover:not(:disabled) { background:${r.secondary}; color:${r.foreground}; }
.sui-citation-carousel-button:focus-visible { ${vi} }
.sui-citation-carousel-button:disabled { opacity:0.5; cursor:default; }
.sui-citation-carousel-index { color:${r.mutedForeground}; font-size:11px; }
.sui-citation-quote { margin:0; padding:4px 8px; border-left:2px solid ${r.borderStrong}; color:${r.mutedForeground}; font-style:italic; }
.sui-citation-quote p { margin:0; }
.sui-citation-quote cite { display:block; margin-top:2px; color:${r.textFaint}; font-size:11px; font-style:normal; }
.sui-suggestion-group { display:flex; gap:6px; overflow-x:auto; padding:2px; scrollbar-width:thin; }
.sui-suggestion { flex:none; min-height:28px; display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border:1px solid ${r.input}; border-radius:${r.radiusFull}; background:${r.card}; color:${r.mutedForeground}; font:inherit; font-size:12px; white-space:nowrap; cursor:pointer; }
.sui-suggestion:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-suggestion:focus-visible { ${vi} }
.sui-open-in-chat { min-height:28px; display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border:1px solid ${r.border}; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:12px; cursor:pointer; }
.sui-open-in-chat:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-open-in-chat:focus-visible { ${vi} }
.sui-open-in-chat-icon { display:inline-flex; width:14px; height:14px; flex:none; }
.sui-open-in-chat-icon svg { width:14px; height:14px; }
`;var yi=`outline:none; border-color:${r.ringBorder}; box-shadow:0 0 0 3px ${r.ring};`,Ng=`
.sui-agentdef { min-width:0; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; overflow:hidden; }
.sui-agentdef-header { min-width:0; display:flex; align-items:center; gap:8px; padding:8px 10px; }
.sui-agentdef-name { min-width:0; font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-agentdef-identity { min-width:0; display:inline-flex; align-items:center; gap:4px; color:${r.mutedForeground}; font-size:11px; font-family:${r.fontMono}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-agentdef-identity-sep { color:${r.textFaint}; }
.sui-agentdef-provider { color:${r.mutedForeground}; }
.sui-agentdef-model { color:${r.foreground}; }
.sui-agentdef-availability { flex:none; display:inline-flex; align-items:center; min-height:20px; padding:0 8px; border:1px solid ${r.border}; border-radius:${r.radiusFull}; color:${r.mutedForeground}; font-size:10px; font-weight:650; text-transform:uppercase; letter-spacing:.02em; }
.sui-agentdef-availability[data-availability='available'] { border-color:${r.successBorder}; background:${r.successSoft}; color:${r.success}; }
.sui-agentdef-availability[data-availability='unauthenticated'] { border-color:${r.warningBorder}; background:${r.warningSoft}; color:${r.warning}; }
.sui-agentdef-availability[data-availability='unavailable'] { border-color:${r.destructiveBorder}; background:${r.destructiveSoft}; color:${r.destructive}; }
.sui-agentdef-content { min-width:0; display:grid; gap:8px; padding:0 10px 10px; }
.sui-agentdef-trigger { width:100%; min-height:28px; display:flex; align-items:center; gap:8px; padding:4px 6px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.foreground}; font:inherit; text-align:left; cursor:pointer; }
.sui-agentdef-trigger:hover { background:${r.secondary}; }
.sui-agentdef-trigger:focus-visible { ${yi} }
.sui-agentdef-chevron { display:inline-flex; align-items:center; justify-content:center; width:12px; flex:none; color:${r.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-agentdef-trigger[aria-expanded='true'] .sui-agentdef-chevron { transform:rotate(90deg); }
.sui-agentdef-trigger-label { min-width:0; font-size:12px; font-weight:650; color:${r.mutedForeground}; text-transform:uppercase; letter-spacing:.04em; }
.sui-agentdef-region { min-width:0; margin:2px 0 6px 20px; padding:8px 10px; border-radius:${r.radiusControl}; background:${r.surface2}; color:${r.mutedForeground}; font-size:${r.fontSizeCompact}; line-height:1.45; }
.sui-agentdef-tools { display:grid; gap:0; margin:0; padding:0; }
.sui-agentdef-tool { min-width:0; border-top:1px solid ${r.border}; list-style:none; }
.sui-agentdef-tool-name { min-width:0; font-size:12px; font-weight:650; font-family:${r.fontMono}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-agentdef-tool-description { margin:0 0 6px; color:${r.mutedForeground}; }
.sui-agentdef-tool-permissions { margin:0 0 6px; color:${r.mutedForeground}; font-size:11px; }
.sui-agentdef-tool-permissions-label { font-weight:650; color:${r.foreground}; }
.sui-agentdef-schema { min-width:0; margin:0 0 6px; max-height:240px; overflow:auto; padding:8px 10px; border:1px solid ${r.border}; border-radius:${r.radiusControl}; background:${r.card}; color:${r.foreground}; font-family:${r.fontMono}; font-size:11px; line-height:1.5; white-space:pre; }
.sui-agentdef-schema:focus-visible { ${yi} }
.sui-agentcard { min-width:0; display:grid; gap:4px; padding:10px 12px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; text-align:left; font:inherit; }
.sui-agentcard-selectable { cursor:pointer; }
.sui-agentcard-selectable:hover { background:${r.hoverSubtle}; }
.sui-agentcard-selectable:focus-visible { ${yi} }
.sui-agentcard-selectable:disabled { cursor:not-allowed; opacity:.45; }
.sui-agentcard[data-selected='true'] { border-color:${r.primaryBorder}; background:${r.primarySoft}; }
.sui-agentcard-header { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; }
.sui-agentcard-name { min-width:0; font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-agentcard-identity { min-width:0; display:inline-flex; align-items:center; gap:4px; color:${r.mutedForeground}; font-size:11px; font-family:${r.fontMono}; }
.sui-agentcard-identity-sep { color:${r.textFaint}; }
.sui-agentcard-provider { color:${r.mutedForeground}; }
.sui-agentcard-model { color:${r.foreground}; }
.sui-agentcard-description { min-width:0; color:${r.mutedForeground}; font-size:${r.fontSizeCompact}; line-height:1.45; }
.sui-model-badge { display:inline-flex; align-items:center; gap:6px; min-width:0; max-width:100%; min-height:20px; padding:0 8px; border:1px solid ${r.primaryBorder}; border-radius:${r.radiusFull}; background:${r.primarySoft}; color:${r.primary}; font-size:11px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sui-model-badge-icon { display:inline-flex; align-items:center; flex:none; }
.sui-model-badge-name { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.sui-model-badge-provider { flex:none; font-weight:500; opacity:.75; }
.sui-provider-badge { display:inline-flex; align-items:center; gap:4px; min-width:0; max-width:100%; min-height:18px; padding:0 6px; border:1px solid ${r.border}; border-radius:${r.radiusFull}; background:${r.hoverSubtle}; color:${r.mutedForeground}; font-size:10px; font-weight:650; text-transform:uppercase; letter-spacing:.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sui-provider-badge-icon { display:inline-flex; align-items:center; flex:none; }
.sui-provider-badge-name { min-width:0; overflow:hidden; text-overflow:ellipsis; }
.sui-model-sel-trigger { gap:8px; }
.sui-model-sel-content { min-width:220px; }
.sui-model-sel-item { align-items:flex-start; }
.sui-model-sel-item-body { min-width:0; display:grid; gap:2px; }
.sui-model-sel-item-row { min-width:0; display:flex; align-items:center; gap:6px; }
.sui-model-sel-item-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-model-sel-item-description { color:${r.mutedForeground}; font-size:11px; line-height:1.35; }
.sui-ctx { position:relative; display:inline-block; min-width:0; }
.sui-ctx-trigger { min-height:24px; display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border:1px solid ${r.border}; border-radius:${r.radiusFull}; background:${r.card}; color:${r.mutedForeground}; font:inherit; font-size:11px; font-variant-numeric:tabular-nums; cursor:pointer; }
.sui-ctx-trigger:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-ctx-trigger:focus-visible { ${yi} }
.sui-ctx-trigger-label { min-width:0; }
.sui-ctx-content { position:absolute; z-index:60; bottom:calc(100% + 6px); right:0; width:240px; padding:10px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.popover}; color:${r.popoverForeground}; box-shadow:0 4px 12px rgb(${r.shadowRgb} / 0.10), 0 16px 48px rgb(${r.shadowRgb} / 0.16); }
.sui-ctx-header { min-width:0; display:flex; align-items:baseline; justify-content:space-between; gap:8px; padding-bottom:6px; border-bottom:1px solid ${r.border}; }
.sui-ctx-header-title { min-width:0; font-size:12px; font-weight:650; color:${r.foreground}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-ctx-header-value { flex:none; color:${r.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-ctx-body { display:grid; gap:4px; padding:6px 0; }
.sui-ctx-row { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; }
.sui-ctx-row-label { color:${r.mutedForeground}; }
.sui-ctx-row-value { color:${r.foreground}; font-variant-numeric:tabular-nums; }
.sui-ctx-footer { min-height:0; padding-top:6px; border-top:1px solid ${r.border}; }
.sui-ctx-footer:empty { display:none; }
.sui-ctx-cost { color:${r.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
`;var pn=`outline:none; border-color:${r.ringBorder}; box-shadow:0 0 0 3px ${r.ring};`,Dg=`
.sui-artifact { display:flex; flex-direction:column; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.foreground}; overflow:hidden; }
.sui-artifact-header { display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid ${r.border}; background:${r.surface2}; }
.sui-artifact-title { margin:0; font-size:13px; font-weight:650; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-artifact-description { margin:0; padding:4px 12px 0; font-size:${r.fontSizeCompact}; color:${r.mutedForeground}; }
.sui-artifact-actions { display:inline-flex; align-items:center; gap:2px; margin-left:auto; }
.sui-artifact-action { display:inline-flex; align-items:center; justify-content:center; min-width:26px; height:26px; padding:0 6px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:${r.fontSizeCompact}; cursor:pointer; }
.sui-artifact-action:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-artifact-action:focus-visible { ${pn} }
.sui-artifact-close { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:18px; line-height:1; cursor:pointer; }
.sui-artifact-close:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-artifact-close:focus-visible { ${pn} }
.sui-artifact-content { padding:12px; min-width:0; }

.sui-snippet { display:inline-flex; align-items:center; gap:8px; max-width:100%; padding:4px 6px 4px 10px; border:1px solid ${r.border}; border-radius:${r.radiusControl}; background:${r.surface2}; color:${r.foreground}; font-size:${r.fontSizeCompact}; }
.sui-snippet-code { font-family:${r.fontMono}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-snippet-copy { flex:none; display:inline-flex; align-items:center; height:22px; padding:0 8px; border:1px solid ${r.input}; border-radius:${r.radiusControl}; background:${r.card}; color:${r.foreground}; font:inherit; font-size:${r.fontSizeCompact}; cursor:pointer; }
.sui-snippet-copy:hover { background:${r.secondary}; }
.sui-snippet-copy:focus-visible { ${pn} }

.sui-pkginfo { display:flex; flex-direction:column; gap:8px; padding:12px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.foreground}; }
.sui-pkginfo-header { display:flex; align-items:baseline; gap:8px; min-width:0; }
.sui-pkginfo-name { font-family:${r.fontMono}; font-size:13px; font-weight:650; color:${r.foreground}; text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
a.sui-pkginfo-name { color:${r.primary}; }
a.sui-pkginfo-name:hover { text-decoration:underline; text-underline-offset:3px; }
.sui-pkginfo-version { font-family:${r.fontMono}; font-size:${r.fontSizeCompact}; color:${r.mutedForeground}; }
.sui-pkginfo-description { margin:0; font-size:${r.fontSizeCompact}; color:${r.mutedForeground}; }

.sui-schema { border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.foreground}; overflow:hidden; }
.sui-schema-trigger { display:flex; align-items:center; gap:6px; width:100%; padding:8px 12px; border:none; background:${r.surface2}; color:${r.foreground}; font:inherit; font-size:13px; font-weight:650; text-align:left; cursor:pointer; }
.sui-schema-trigger:hover { background:${r.secondary}; }
.sui-schema-trigger:focus-visible { ${pn} }
.sui-schema-trigger::before { content:""; flex:none; width:0; height:0; border-left:4px solid ${r.mutedForeground}; border-top:4px solid transparent; border-bottom:4px solid transparent; transition:transform .12s ease; }
.sui-schema[data-state='open'] > .sui-schema-trigger::before { transform:rotate(90deg); }
.sui-schema-content { padding:8px 12px 12px; }
.sui-schema-list { margin:0; display:flex; flex-direction:column; gap:4px; }
.sui-schema-list .sui-schema-list { margin:4px 0 0 12px; padding-left:8px; border-left:1px solid ${r.border}; }
.sui-schema-row { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px; font-size:${r.fontSizeCompact}; }
.sui-schema-name { font-family:${r.fontMono}; font-weight:650; color:${r.foreground}; }
.sui-schema-required { color:${r.destructive}; font-size:${r.fontSizeCompact}; }
.sui-schema-type { font-family:${r.fontMono}; color:${r.info}; }
.sui-schema-description { margin:0; flex-basis:100%; color:${r.mutedForeground}; }

.sui-stack { border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.foreground}; overflow:hidden; }
.sui-stack-trigger { display:flex; align-items:center; gap:6px; width:100%; padding:8px 12px; border:none; background:${r.surface2}; color:${r.foreground}; font:inherit; font-size:${r.fontSizeCompact}; font-weight:650; text-align:left; cursor:pointer; }
.sui-stack-trigger:hover { background:${r.secondary}; }
.sui-stack-trigger:focus-visible { ${pn} }
.sui-stack-trigger::before { content:""; flex:none; width:0; height:0; border-left:4px solid ${r.mutedForeground}; border-top:4px solid transparent; border-bottom:4px solid transparent; transition:transform .12s ease; }
.sui-stack[data-state='open'] > .sui-stack-trigger::before { transform:rotate(90deg); }
.sui-stack-content { padding:4px 0; }
.sui-stack-frames { margin:0; padding:0; list-style:none; }
.sui-stack-frame { padding:2px 12px; font-family:${r.fontMono}; font-size:${r.fontSizeCompact}; color:${r.mutedForeground}; }
.sui-stack-frame-button { display:block; width:100%; padding:0; border:none; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; border-radius:${r.radiusControl}; }
.sui-stack-frame-button:hover { color:${r.foreground}; background:${r.hoverSubtle}; }
.sui-stack-frame-button:focus-visible { ${pn} }
.sui-stack-frame-fn { color:${r.foreground}; }
.sui-stack-frame-loc { color:${r.mutedForeground}; }
.sui-stack-raw { margin:0; padding:8px 12px; font-family:${r.fontMono}; font-size:${r.fontSizeCompact}; color:${r.mutedForeground}; white-space:pre-wrap; word-break:break-word; }

.sui-tests { display:flex; flex-direction:column; gap:8px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.foreground}; padding:12px; }
.sui-tests-header { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.sui-tests-summary { display:inline-flex; align-items:center; gap:8px; font-size:${r.fontSizeCompact}; color:${r.mutedForeground}; }
.sui-tests-summary-count[data-tone='ok'] { color:${r.success}; }
.sui-tests-summary-count[data-tone='bad'] { color:${r.destructive}; }
.sui-tests-summary-count[data-tone='muted'] { color:${r.mutedForeground}; }
.sui-tests-summary-count[data-tone='run'] { color:${r.primary}; }
.sui-tests-duration { font-family:${r.fontMono}; font-size:${r.fontSizeCompact}; color:${r.mutedForeground}; }
.sui-tests-progress { flex:1; min-width:120px; }
.sui-tests-content { display:flex; flex-direction:column; gap:6px; }
.sui-tests-suite { border:1px solid ${r.border}; border-radius:${r.radiusControl}; overflow:hidden; }
.sui-tests-suite-trigger { display:flex; align-items:center; gap:8px; width:100%; padding:6px 10px; border:none; background:${r.surface2}; color:${r.foreground}; font:inherit; font-size:13px; text-align:left; cursor:pointer; }
.sui-tests-suite-trigger:hover { background:${r.secondary}; }
.sui-tests-suite-trigger:focus-visible { ${pn} }
.sui-tests-suite-trigger::before { content:""; flex:none; width:0; height:0; border-left:4px solid ${r.mutedForeground}; border-top:4px solid transparent; border-bottom:4px solid transparent; transition:transform .12s ease; }
.sui-tests-suite[data-state='open'] > .sui-tests-suite-trigger::before { transform:rotate(90deg); }
.sui-tests-suite-name { font-weight:650; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-tests-suite-stats { font-size:${r.fontSizeCompact}; color:${r.mutedForeground}; }
.sui-tests-suite-content { display:flex; flex-direction:column; }
.sui-tests-row { display:flex; align-items:baseline; gap:8px; padding:4px 10px; font-size:${r.fontSizeCompact}; border-top:1px solid ${r.border}; }
.sui-tests-row[data-status='failed'] { background:${r.destructiveSoft}; }
.sui-tests-name { flex:1; min-width:0; font-family:${r.fontMono}; overflow-wrap:anywhere; }
.sui-tests-row-duration { font-family:${r.fontMono}; color:${r.mutedForeground}; }
.sui-tests-row-detail { flex-basis:100%; display:flex; flex-direction:column; gap:6px; padding:4px 0; }
.sui-tests-row-error { margin:0; font-family:${r.fontMono}; font-size:${r.fontSizeCompact}; color:${r.destructive}; white-space:pre-wrap; word-break:break-word; }

.sui-commit { display:flex; flex-direction:column; gap:8px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.foreground}; padding:12px; }
.sui-commit-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.sui-commit-author { font-size:13px; font-weight:650; }
.sui-commit-info { display:inline-flex; align-items:center; gap:8px; margin-left:auto; font-size:${r.fontSizeCompact}; color:${r.mutedForeground}; }
.sui-commit-message { font-size:13px; overflow-wrap:anywhere; white-space:pre-wrap; }
.sui-commit-metadata { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:${r.fontSizeCompact}; color:${r.mutedForeground}; }
.sui-commit-hash { font-family:${r.fontMono}; font-size:${r.fontSizeCompact}; color:${r.mutedForeground}; }
.sui-commit-hash[data-vcs='jj'] { color:${r.info}; }
.sui-commit-timestamp { font-size:${r.fontSizeCompact}; color:${r.mutedForeground}; }
.sui-commit-actions { display:inline-flex; align-items:center; gap:4px; }
.sui-commit-files { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; border:1px solid ${r.border}; border-radius:${r.radiusControl}; overflow:hidden; }
.sui-commit-file { display:flex; align-items:baseline; gap:8px; padding:4px 10px; font-family:${r.fontMono}; font-size:${r.fontSizeCompact}; }
.sui-commit-file + .sui-commit-file { border-top:1px solid ${r.border}; }
.sui-commit-file-status { flex:none; display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:4px; font-size:10px; font-weight:650; }
.sui-commit-file-status[data-tone='ok'] { color:${r.success}; background:${r.successSoft}; }
.sui-commit-file-status[data-tone='bad'] { color:${r.destructive}; background:${r.destructiveSoft}; }
.sui-commit-file-status[data-tone='warn'] { color:${r.warning}; background:${r.warningSoft}; }
.sui-commit-file-status[data-tone='muted'] { color:${r.mutedForeground}; background:${r.secondary}; }
.sui-commit-file-status[data-tone='run'] { color:${r.info}; background:${r.infoSoft}; }
.sui-commit-file-path { flex:1; min-width:0; overflow-wrap:anywhere; }
.sui-commit-file-counts { color:${r.mutedForeground}; }
.sui-commit-file-counts .sui-commit-add { color:${r.success}; }
.sui-commit-file-counts .sui-commit-del { color:${r.destructive}; }

.sui-changesum { display:inline-flex; align-items:center; gap:8px; font-family:${r.fontMono}; font-size:${r.fontSizeCompact}; color:${r.mutedForeground}; }
.sui-changesum-add { color:${r.success}; }
.sui-changesum-del { color:${r.destructive}; }
.sui-changesum-files { color:${r.mutedForeground}; }

.sui-envvars { display:flex; flex-direction:column; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.foreground}; overflow:hidden; }
.sui-envvar { display:flex; align-items:center; gap:12px; padding:6px 12px; font-size:${r.fontSizeCompact}; }
.sui-envvar + .sui-envvar { border-top:1px solid ${r.border}; }
.sui-envvar-name { font-family:${r.fontMono}; font-weight:650; color:${r.foreground}; }
.sui-envvar-value { font-family:${r.fontMono}; color:${r.mutedForeground}; overflow-wrap:anywhere; }
.sui-envvar-unset { color:${r.placeholder}; }

.sui-secret { display:inline-flex; align-items:center; gap:6px; font-family:${r.fontMono}; font-size:${r.fontSizeCompact}; color:${r.foreground}; }
.sui-secret-mask { letter-spacing:2px; color:${r.mutedForeground}; }
.sui-secret-value { overflow-wrap:anywhere; }
.sui-secret-toggle, .sui-secret-copy { display:inline-flex; align-items:center; height:20px; padding:0 6px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:11px; cursor:pointer; }
.sui-secret-toggle:hover, .sui-secret-copy:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-secret-toggle:focus-visible, .sui-secret-copy:focus-visible { ${pn} }
`;var Ug=`
.sui-sandbox { border:1px solid var(--border, rgba(64,63,83,0.08)); border-radius:var(--r-2, 10px); background:var(--surface, #fefefe); overflow:hidden; }
.sui-sandbox-trigger { display:flex; align-items:center; gap:6px; width:100%; padding:8px 10px; border:0; background:transparent; color:var(--text, #403f53); font:inherit; font-size:var(--fs-2, 12px); font-weight:650; cursor:pointer; text-align:left; }
.sui-sandbox-trigger:hover { background:var(--hover-subtle, rgba(64,63,83,0.04)); }
.sui-sandbox-trigger:focus-visible { outline:none; border-color:color-mix(in srgb, var(--brand, #9449bc) 50%, transparent); box-shadow:0 0 0 3px color-mix(in srgb, var(--brand, #9449bc) 22%, transparent); }
.sui-sandbox-chevron { display:inline-block; transition:transform 120ms ease; color:var(--text-muted, #676676); }
.sui-sandbox[data-state='open'] > .sui-sandbox-trigger .sui-sandbox-chevron { transform:rotate(90deg); }
.sui-sandbox-header { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:6px 10px; border-top:1px solid var(--border, rgba(64,63,83,0.08)); font-size:var(--fs-2, 12px); }
.sui-sandbox-identity { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; flex:1; }
.sui-sandbox-workspace, .sui-sandbox-repository { display:inline-flex; align-items:center; gap:4px; color:var(--text-muted, #676676); font-family:ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace; }
.sui-sandbox-repository { color:var(--text, #403f53); }
.sui-sandbox-actions { display:flex; align-items:center; gap:6px; padding:6px 10px; border-top:1px solid var(--border, rgba(64,63,83,0.08)); }
.sui-sandbox-action { display:inline-flex; align-items:center; gap:4px; min-height:var(--ctl-h, 32px); padding:0 10px; border:1px solid var(--border-solid, #e6e6e9); border-radius:var(--r-1, 6px); background:var(--surface, #fefefe); color:var(--text, #403f53); font:inherit; font-size:var(--fs-2, 12px); cursor:pointer; }
.sui-sandbox-action:hover { background:var(--hover, #f4f3f5); }
.sui-sandbox-action:focus-visible { outline:none; border-color:color-mix(in srgb, var(--brand, #9449bc) 50%, transparent); box-shadow:0 0 0 3px color-mix(in srgb, var(--brand, #9449bc) 22%, transparent); }
.sui-sandbox-content { border-top:1px solid var(--border, rgba(64,63,83,0.08)); padding:8px 10px; }
.sui-webpreview { display:flex; flex-direction:column; border:1px solid var(--border, rgba(64,63,83,0.08)); border-radius:var(--r-2, 10px); background:var(--surface, #fefefe); overflow:hidden; }
.sui-webpreview-toolbar { display:flex; align-items:center; gap:4px; padding:6px 8px; border-bottom:1px solid var(--border, rgba(64,63,83,0.08)); }
.sui-webpreview-toolbar-button { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border:0; border-radius:var(--r-1, 6px); background:transparent; color:var(--text-muted, #676676); font:inherit; cursor:pointer; }
.sui-webpreview-toolbar-button:hover { background:var(--hover, #f4f3f5); color:var(--text, #403f53); }
.sui-webpreview-toolbar-button:focus-visible { outline:none; box-shadow:0 0 0 3px color-mix(in srgb, var(--brand, #9449bc) 22%, transparent); }
.sui-webpreview-address { flex:1; min-width:0; }
.sui-webpreview-address-row { display:flex; flex-direction:column; gap:2px; flex:1; min-width:0; }
.sui-webpreview-address-error { color:var(--danger, #ba3f3c); font-size:var(--fs-2, 12px); }
.sui-webpreview-content { position:relative; min-height:120px; background:var(--surface-2, #f4f3f5); }
.sui-webpreview-frame { display:block; width:100%; height:100%; min-height:120px; border:0; background:var(--surface, #fefefe); }
.sui-webpreview-loading { position:absolute; inset:0; z-index:1; }
.sui-jsxpreview { border:1px solid var(--border, rgba(64,63,83,0.08)); border-radius:var(--r-2, 10px); background:var(--surface, #fefefe); overflow:hidden; }
.sui-jsxpreview-frame { padding:8px 10px; }
`;var jg=`
.sui-canvas { position:relative; width:100%; height:100%; min-height:240px; overflow:hidden; background:var(--surface-2, #f4f3f5); border-radius:var(--r-2, 10px); }
.sui-canvas-node { display:grid; gap:6px; align-content:center; box-sizing:border-box; min-width:180px; padding:12px 14px; border:1px solid var(--border, rgba(64,63,83,0.08)); border-radius:var(--r-1, 6px); background:var(--surface, #fefefe); box-shadow:0 8px 18px rgb(var(--shadow-rgb, 64 63 83) / 0.08); }
.sui-canvas-node[data-selected='true'] { border-color:color-mix(in srgb, var(--brand, #9449bc) 50%, transparent); box-shadow:0 0 0 3px color-mix(in srgb, var(--brand, #9449bc) 22%, transparent), 0 8px 18px rgb(var(--shadow-rgb, 64 63 83) / 0.08); }
.sui-canvas-node-header { display:flex; align-items:center; gap:6px; min-width:0; }
.sui-canvas-node-kind { flex:none; text-transform:uppercase; }
.sui-canvas-node-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; font-weight:650; color:var(--text, #403f53); }
.sui-canvas-node-status { margin-left:auto; flex:none; }
.sui-canvas-node-content { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-muted, #676676); font-size:var(--fs-2, 12px); }
.sui-canvas-edge { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border:1px solid var(--border, rgba(64,63,83,0.08)); border-radius:var(--r-full, 999px); background:var(--surface, #fefefe); color:var(--text-muted, #676676); font-size:var(--fs-2, 12px); }
.sui-canvas-edge-glyph { display:inline-flex; align-items:center; justify-content:center; width:12px; height:12px; flex:none; font-size:10px; line-height:1; color:var(--text-muted, #676676); }
.sui-canvas-edge[data-status-class='run'] .sui-canvas-edge-glyph { color:var(--brand, #9449bc); }
.sui-canvas-edge[data-status-class='ok'] .sui-canvas-edge-glyph { color:var(--success, #21766f); }
.sui-canvas-edge[data-status-class='warn'] .sui-canvas-edge-glyph { color:var(--warning, #846701); }
.sui-canvas-edge[data-status-class='bad'] .sui-canvas-edge-glyph { color:var(--danger, #ba3f3c); }
.sui-canvas-edge-arrow { color:var(--text-faint, #6b6a7a); }
.sui-canvas-edge-label { color:var(--text, #403f53); }
.sui-canvas-connection { display:inline-block; width:48px; border-top:2px dashed var(--border-strong, rgba(64,63,83,0.14)); }
.sui-canvas-connection[data-status='valid'] { border-top-style:solid; border-top-color:var(--success, #21766f); }
.sui-canvas-connection[data-status='invalid'] { border-top-color:var(--danger, #ba3f3c); }
.sui-canvas-connection[data-status='pending'] { border-top-color:var(--brand, #9449bc); }
.sui-canvas-controls { display:flex; flex-direction:column; gap:2px; width:max-content; padding:4px; border:1px solid var(--border, rgba(64,63,83,0.08)); border-radius:var(--r-1, 6px); background:var(--surface, #fefefe); box-shadow:0 2px 8px rgb(var(--shadow-rgb, 64 63 83) / 0.08); }
.sui-canvas-controls-button { display:flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border:0; border-radius:var(--r-1, 6px); background:transparent; color:var(--text, #403f53); font-size:18px; line-height:1; cursor:pointer; }
.sui-canvas-controls-button:hover { background:var(--hover, #f4f3f5); }
.sui-canvas-controls-button:focus-visible { outline:none; box-shadow:0 0 0 3px color-mix(in srgb, var(--brand, #9449bc) 22%, transparent); }
.sui-canvas-panel { position:absolute; z-index:5; display:flex; gap:8px; margin:12px; max-width:calc(100% - 24px); }
.sui-canvas-panel[data-position='top-left'] { top:0; left:0; }
.sui-canvas-panel[data-position='top-right'] { top:0; right:0; }
.sui-canvas-panel[data-position='bottom-left'] { bottom:0; left:0; }
.sui-canvas-panel[data-position='bottom-right'] { bottom:0; right:0; }
.sui-canvas-toolbar { display:flex; align-items:center; gap:4px; width:max-content; padding:4px; border:1px solid var(--border, rgba(64,63,83,0.08)); border-radius:var(--r-1, 6px); background:var(--surface, #fefefe); }
.sui-canvas-minimap { box-sizing:border-box; width:160px; height:100px; overflow:hidden; border:1px solid var(--border, rgba(64,63,83,0.08)); border-radius:var(--r-1, 6px); background:var(--surface, #fefefe); box-shadow:0 2px 8px rgb(var(--shadow-rgb, 64 63 83) / 0.08); }
`;var Mn="transition:background-color .12s ease, border-color .12s ease, color .12s ease;",Lg=`
.sui-cal { min-width:0; display:grid; align-content:start; gap:10px; color:${r.foreground}; font-family:${r.fontSans}; font-size:13px; }
.sui-cal-header { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.sui-cal-title { min-width:0; color:${r.foreground}; font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-cal-controls { display:flex; align-items:center; gap:8px; flex:none; flex-wrap:wrap; }
.sui-cal-segment { display:inline-flex; align-items:center; gap:2px; padding:2px; border:1px solid ${r.input}; border-radius:${r.radiusControl}; background:${r.secondary}; }
.sui-cal-segment-button { min-height:26px; display:inline-flex; align-items:center; justify-content:center; padding:0 10px; border:none; border-radius:4px; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:12px; font-weight:650; cursor:pointer; white-space:nowrap; ${Mn} }
.sui-cal-segment-button:hover { color:${r.foreground}; }
.sui-cal-segment-button:focus-visible { outline:none; box-shadow:0 0 0 3px ${r.ring}; }
.sui-cal-segment-button[data-active='true'] { background:${r.card}; color:${r.foreground}; box-shadow:${r.shadow1}; }

/* Month */
.sui-cal-grid { display:grid; grid-template-columns:repeat(7, minmax(0, 1fr)); gap:1px; overflow:hidden; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.border}; }
.sui-cal-weekday { padding:6px 8px; background:${r.card}; color:${r.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-cal-day { position:relative; min-width:0; min-height:96px; display:grid; align-content:start; gap:2px; padding:4px; border:none; background:${r.card}; color:${r.foreground}; font:inherit; text-align:left; cursor:pointer; ${Mn} }
.sui-cal-day:hover { background:${r.secondary}; }
.sui-cal-day:focus-visible { outline:none; box-shadow:inset 0 0 0 3px ${r.ring}; }
.sui-cal-day[data-outside='true'] { background:${r.surface2}; }
.sui-cal-day[data-outside='true']:hover { background:${r.secondary}; }
.sui-cal-day[data-today='true'] { background:${r.primarySoft}; }
.sui-cal-day-num { display:inline-grid; place-items:center; min-width:22px; height:22px; padding:0 4px; border-radius:${r.radiusFull}; color:${r.mutedForeground}; font-size:12px; justify-self:start; }
.sui-cal-day[data-today='true'] .sui-cal-day-num { background:${r.primary}; color:${r.primaryForeground}; font-weight:650; }
.sui-cal-day[data-outside='true'] .sui-cal-day-num { color:${r.textFaint}; }

/* Event chips (month cells, all-day lanes, popovers) */
.sui-cal-chip { min-width:0; width:100%; min-height:20px; display:inline-flex; align-items:center; gap:4px; padding:0 4px; border:1px solid ${r.border}; border-radius:4px; background:${r.hoverSubtle}; color:${r.foreground}; font:inherit; font-size:11px; line-height:1.3; text-align:left; text-decoration:none; cursor:pointer; ${Mn} }
.sui-cal-chip:hover { border-color:currentColor; }
.sui-cal-chip:focus-visible { outline:none; box-shadow:0 0 0 3px ${r.ring}; }
.sui-cal-chip[data-tint='brand'] { border-color:${r.primaryBorder}; background:${r.primarySoft}; color:${r.primary}; }
.sui-cal-chip[data-tint='success'] { border-color:${r.successBorder}; background:${r.successSoft}; color:${r.success}; }
.sui-cal-chip[data-tint='info'] { border-color:${r.infoBorder}; background:${r.infoSoft}; color:${r.info}; }
.sui-cal-chip[data-tint='warning'] { border-color:${r.warningBorder}; background:${r.warningSoft}; color:${r.warning}; }
.sui-cal-chip-dot { width:6px; height:6px; flex:none; border-radius:${r.radiusFull}; background:currentColor; }
.sui-cal-chip-time { flex:none; font-variant-numeric:tabular-nums; color:color-mix(in srgb, currentColor 75%, transparent); }
.sui-cal-chip-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-cal-more { min-height:20px; display:inline-flex; align-items:center; padding:0 4px; border:none; border-radius:4px; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:11px; font-weight:650; text-align:left; cursor:pointer; ${Mn} }
.sui-cal-more:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-cal-more:focus-visible { outline:none; box-shadow:0 0 0 3px ${r.ring}; }
.sui-cal-popover { position:absolute; z-index:30; top:calc(100% + 2px); left:0; width:240px; max-height:280px; overflow:auto; display:grid; align-content:start; gap:2px; padding:6px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.popover}; color:${r.popoverForeground}; box-shadow:${r.shadow3}; }
.sui-cal-popover[data-align='end'] { left:auto; right:0; }
.sui-cal-popover[data-placement='up'] { top:auto; bottom:calc(100% + 2px); }
.sui-cal-popover-label { padding:2px 4px; color:${r.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }

/* Week time grid */
.sui-cal-week { min-width:0; overflow:hidden; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; }
.sui-cal-week-scroll { overflow-x:auto; }
.sui-cal-week-inner { min-width:604px; display:grid; }
.sui-cal-week-head { display:grid; grid-template-columns:44px repeat(7, minmax(0, 1fr)); border-bottom:1px solid ${r.border}; }
.sui-cal-week-corner { background:${r.card}; }
.sui-cal-week-day { min-width:0; display:grid; justify-items:center; gap:2px; padding:6px 4px; border:none; border-left:1px solid ${r.border}; background:${r.card}; color:${r.foreground}; font:inherit; cursor:pointer; ${Mn} }
.sui-cal-week-day:hover { background:${r.secondary}; }
.sui-cal-week-day:focus-visible { outline:none; box-shadow:inset 0 0 0 3px ${r.ring}; }
.sui-cal-week-day-label { color:${r.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-cal-week-day-num { display:inline-grid; place-items:center; min-width:24px; height:24px; padding:0 4px; border-radius:${r.radiusFull}; font-size:13px; }
.sui-cal-week-day[data-today='true'] .sui-cal-week-day-num { background:${r.primary}; color:${r.primaryForeground}; font-weight:650; }
.sui-cal-week-allday { display:grid; grid-template-columns:44px repeat(7, minmax(0, 1fr)); border-bottom:1px solid ${r.border}; }
.sui-cal-week-allday-label { display:grid; align-content:center; justify-items:end; padding:2px 4px; color:${r.textFaint}; font-size:10px; }
.sui-cal-week-allday-cell { min-width:0; min-height:28px; display:grid; align-content:start; gap:2px; padding:2px; border-left:1px solid ${r.border}; }
.sui-cal-week-body { display:grid; grid-template-columns:44px repeat(7, minmax(0, 1fr)); }
.sui-cal-week-gutter { position:relative; }
.sui-cal-week-hour { position:absolute; right:4px; transform:translateY(-50%); padding:0 2px; background:${r.card}; color:${r.textFaint}; font-size:10px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.sui-cal-week-col { position:relative; border-left:1px solid ${r.border}; background-image:repeating-linear-gradient(to bottom, ${r.border} 0, ${r.border} 1px, transparent 1px, transparent 44px); }
.sui-cal-week-event { position:absolute; z-index:1; left:2px; right:2px; min-width:0; display:grid; align-content:start; padding:2px 4px; border:1px solid ${r.border}; border-radius:4px; background:${r.hoverSubtle}; color:${r.foreground}; font:inherit; font-size:11px; line-height:1.3; text-align:left; text-decoration:none; cursor:pointer; overflow:hidden; ${Mn} }
.sui-cal-week-event:hover { border-color:currentColor; z-index:2; }
.sui-cal-week-event:focus-visible { outline:none; box-shadow:0 0 0 3px ${r.ring}; z-index:2; }
.sui-cal-week-event[data-tint='brand'] { border-color:${r.primaryBorder}; background:${r.primarySoft}; color:${r.primary}; }
.sui-cal-week-event[data-tint='success'] { border-color:${r.successBorder}; background:${r.successSoft}; color:${r.success}; }
.sui-cal-week-event[data-tint='info'] { border-color:${r.infoBorder}; background:${r.infoSoft}; color:${r.info}; }
.sui-cal-week-event[data-tint='warning'] { border-color:${r.warningBorder}; background:${r.warningSoft}; color:${r.warning}; }
.sui-cal-week-event-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:650; }
.sui-cal-week-event-time { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-variant-numeric:tabular-nums; color:color-mix(in srgb, currentColor 75%, transparent); }
.sui-cal-now-line { position:absolute; z-index:3; left:0; right:0; height:0; border-top:1px solid ${r.destructive}; pointer-events:none; }
.sui-cal-now-line::before { content:""; position:absolute; left:-3px; top:-4px; width:7px; height:7px; border-radius:${r.radiusFull}; background:${r.destructive}; }

/* Agenda */
.sui-cal-agenda { min-width:0; display:grid; align-content:start; gap:10px; }
.sui-cal-agenda-day { min-width:0; display:grid; align-content:start; gap:2px; }
.sui-cal-agenda-day-label { display:flex; align-items:baseline; gap:8px; padding:0 2px; color:${r.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-cal-agenda-row { min-width:0; width:100%; display:flex; align-items:center; gap:8px; padding:6px 10px; border:1px solid ${r.border}; border-radius:${r.radiusControl}; background:${r.card}; color:${r.foreground}; font:inherit; font-size:13px; text-align:left; text-decoration:none; cursor:pointer; ${Mn} }
.sui-cal-agenda-row:hover { background:${r.secondary}; }
.sui-cal-agenda-row:focus-visible { outline:none; border-color:${r.ringBorder}; box-shadow:0 0 0 3px ${r.ring}; }
.sui-cal-agenda-time { flex:none; width:84px; overflow:hidden; color:${r.mutedForeground}; font-size:12px; font-variant-numeric:tabular-nums; text-overflow:ellipsis; white-space:nowrap; }
.sui-cal-agenda-title { min-width:0; flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-cal-agenda-source { flex:none; max-width:140px; overflow:hidden; color:${r.mutedForeground}; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
`;var qg=`
.sui-vault-graph-shell { min-width:0; display:grid; gap:8px; }
.sui-vault-graph-head { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; }
.sui-vault-graph-actions { display:flex; align-items:center; gap:6px; flex:none; }
.sui-vault-graph { display:block; width:100%; height:auto; border:1px solid var(--border, rgba(64,63,83,0.08)); border-radius:var(--r-2, 10px); background:var(--surface, #fefefe); color:var(--text-muted, #676676); touch-action:none; user-select:none; }
.sui-vault-graph-edge { stroke:currentColor; }
.sui-vault-graph-node circle { fill:currentColor; stroke:var(--border-strong, rgba(64,63,83,0.14)); }
.sui-vault-graph-node[data-tint='brand'] { color:color-mix(in srgb, var(--brand, #9449bc) 80%, var(--text, #403f53)); }
.sui-vault-graph-node[data-tint='success'] { color:color-mix(in srgb, var(--success, #21766f) 80%, var(--text, #403f53)); }
.sui-vault-graph-node[data-tint='info'] { color:color-mix(in srgb, var(--info, #3f66ba) 80%, var(--text, #403f53)); }
.sui-vault-graph-node[data-tint='warning'] { color:color-mix(in srgb, var(--warning, #846701) 80%, var(--text, #403f53)); }
.sui-vault-graph-label { fill:var(--text-muted, #676676); }
.sui-vault-graph-meta { color:var(--text-muted, #676676); font-size:11px; }
.sui-vault-graph-fallback { min-width:0; display:grid; gap:6px; align-content:start; }
.sui-vault-links { min-width:0; display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; }
.sui-vault-links-section { min-width:0; display:grid; gap:6px; align-content:start; }
.sui-vault-links-head { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:8px; }
.sui-vault-links-empty { margin:0; color:var(--text-muted, #676676); font-size:var(--fs-2, 12px); }
.sui-vault-link-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-vault-link-path { min-width:0; max-width:50%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-faint, #6b6a7a); font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace); font-size:11px; }
.sui-vault-outline { min-width:0; display:flex; flex-direction:column; gap:1px; }
.sui-vault-outline-item { display:flex; align-items:center; width:100%; min-height:28px; padding:2px 8px; border:none; border-radius:var(--r-1, 6px); background:transparent; color:var(--text, #403f53); font:inherit; font-size:13px; text-align:left; cursor:pointer; transition:background-color .12s ease, border-color .12s ease, color .12s ease; }
.sui-vault-outline-item:hover { background:var(--hover, #f4f3f5); }
.sui-vault-outline-item:focus-visible { outline:none; box-shadow:0 0 0 3px var(--ring, color-mix(in srgb, var(--brand, #9449bc) 22%, transparent)); }
.sui-vault-outline-item[data-depth='1'] { font-weight:650; }
.sui-vault-outline-empty { margin:0; padding:8px; color:var(--text-muted, #676676); font-size:var(--fs-2, 12px); }
`;var wi=r.shadow2,Fg=r.shadow3,P=`outline:none; border-color:${r.ringBorder}; box-shadow:0 0 0 3px ${r.ring};`,re="transition:background-color .12s ease, border-color .12s ease, color .12s ease;",Tx=`@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-delay:0ms !important; animation-duration:0.001ms !important; animation-iteration-count:1 !important; scroll-behavior:auto !important; transition-delay:0ms !important; transition-duration:0.001ms !important; }
}`,Ex=`
.sui-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
@keyframes sui-shimmer-sweep { from { background-position:200% 0; } to { background-position:-200% 0; } }
`,Cx=`
.sui-button { min-height:${r.controlHeight}; display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:0 12px; border:1px solid ${r.input}; border-radius:${r.radiusControl}; background:${r.card}; color:${r.foreground}; font:inherit; font-size:13px; text-decoration:none; cursor:pointer; white-space:nowrap; user-select:none; ${re} }
.sui-button:hover { background:${r.secondary}; }
.sui-button:active:not(:disabled) { background:color-mix(in srgb, ${r.foreground} 6%, ${r.secondary}); }
.sui-button:focus-visible { ${P} }
.sui-button:disabled, .sui-button[aria-disabled='true'] { cursor:not-allowed; opacity:.45; }
.sui-button svg { flex:none; }
.sui-button-default { border-color:color-mix(in srgb, ${r.primary} 40%, transparent); background:color-mix(in srgb, ${r.primary} 10%, ${r.card}); color:${r.primary}; font-weight:650; }
.sui-button-default:hover { background:color-mix(in srgb, ${r.primary} 16%, ${r.card}); }
.sui-button-default:active:not(:disabled) { background:color-mix(in srgb, ${r.primary} 22%, ${r.card}); }
.sui-button-solid { border-color:${r.primary}; background:${r.primary}; color:${r.primaryForeground}; font-weight:650; }
.sui-button-solid:hover { background:color-mix(in srgb, ${r.primary} 88%, ${r.foreground}); }
.sui-button-solid:active:not(:disabled) { background:color-mix(in srgb, ${r.primary} 80%, ${r.foreground}); }
.sui-button-secondary { border-color:transparent; background:${r.secondary}; color:${r.foreground}; }
.sui-button-secondary:hover { background:color-mix(in srgb, ${r.foreground} 6%, ${r.secondary}); }
.sui-button-secondary:active:not(:disabled) { background:color-mix(in srgb, ${r.foreground} 10%, ${r.secondary}); }
/* Intentionally empty: the base .sui-button IS the outline look; the
   variant class exists so consumers can target it. Do not clean up. */
.sui-button-outline { }
.sui-button-ghost { border-color:transparent; background:transparent; }
.sui-button-ghost:hover { background:${r.secondary}; }
.sui-button-ghost:active:not(:disabled) { background:color-mix(in srgb, ${r.foreground} 6%, ${r.secondary}); }
.sui-button-destructive { border-color:color-mix(in srgb, ${r.destructive} 38%, transparent); background:${r.card}; color:${r.destructive}; }
.sui-button-destructive:hover { background:color-mix(in srgb, ${r.destructive} 8%, ${r.card}); }
.sui-button-destructive:active:not(:disabled) { background:color-mix(in srgb, ${r.destructive} 14%, ${r.card}); }
.sui-button-link { min-height:auto; border:none; padding:0; background:transparent; color:${r.primary}; text-decoration:underline; text-underline-offset:3px; }
.sui-button-link:hover { background:transparent; text-decoration-thickness:2px; }
.sui-button-sm { min-height:26px; padding:0 8px; font-size:12px; }
.sui-button-lg { min-height:38px; padding:0 16px; }
.sui-button-icon-size { min-height:${r.controlHeight}; width:32px; padding:0; }
`,Ax=`
.sui-badge { display:inline-flex; align-items:center; gap:6px; min-width:0; max-width:100%; min-height:22px; padding:0 10px; border:1px solid ${r.border}; border-radius:${r.radiusFull}; background:transparent; color:${r.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sui-badge-default { border-color:${r.primaryBorder}; background:${r.primarySoft}; color:${r.primary}; }
.sui-badge-secondary { border-color:${r.border}; background:${r.hoverSubtle}; color:${r.mutedForeground}; }
.sui-badge-outline { border-color:${r.input}; color:${r.foreground}; }
.sui-badge-success { border-color:${r.successBorder}; background:${r.successSoft}; color:${r.success}; }
.sui-badge-warning { border-color:${r.warningBorder}; background:${r.warningSoft}; color:${r.warning}; }
.sui-badge-destructive { border-color:${r.destructiveBorder}; background:${r.destructiveSoft}; color:${r.destructive}; }
.sui-badge-muted { border-color:${r.border}; background:color-mix(in srgb, ${r.mutedForeground} 12%, transparent); color:${r.mutedForeground}; }
.sui-status-dot { width:6px; height:6px; flex:none; border-radius:${r.radiusFull}; background:currentColor; }
`,Ox=`
.sui-card { min-width:0; display:grid; align-content:start; gap:10px; padding:14px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; box-shadow:${wi}; }
.sui-card[role='button'] { cursor:pointer; ${re} }
.sui-card[role='button']:hover { background:${r.secondary}; }
.sui-card[role='button']:focus-visible { ${P} }
.sui-card-header { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; }
.sui-card-title { min-width:0; color:${r.cardForeground}; font-size:13px; font-weight:650; }
.sui-card-description { min-width:0; color:${r.mutedForeground}; font-size:12px; line-height:1.45; }
.sui-card-action { display:flex; align-items:center; gap:8px; flex:none; }
.sui-card-content { min-width:0; display:grid; align-content:start; gap:8px; }
.sui-card-footer { min-width:0; display:flex; align-items:center; gap:8px; }
`,Rx=`
.sui-input { min-width:0; min-height:${r.controlHeight}; padding:0 10px; border:1px solid ${r.input}; border-radius:${r.radiusControl}; background:${r.card}; color:${r.foreground}; font:inherit; font-size:13px; outline:none; }
.sui-input:focus-visible { ${P} }
.sui-input::placeholder { color:${r.placeholder}; }
.sui-input:disabled { cursor:not-allowed; opacity:.45; }
.sui-textarea { min-width:0; min-height:88px; padding:10px 12px; border:1px solid ${r.input}; border-radius:${r.radiusControl}; background:${r.card}; color:${r.foreground}; font:inherit; font-size:13px; line-height:1.45; resize:vertical; outline:none; }
.sui-textarea:focus-visible { ${P} }
.sui-textarea::placeholder { color:${r.placeholder}; }
.sui-textarea:disabled { cursor:not-allowed; opacity:.45; }
.sui-label { color:${r.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-field { min-width:0; display:grid; gap:6px; }
`,zx=`
.sui-chat-transcript { flex:1 1 auto; min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.sui-chat-messages { display:flex; flex-direction:column; gap:18px; width:min(100%, 720px); min-height:100%; margin:0 auto; padding:36px 24px 156px; }
.sui-chat-empty { display:grid; place-items:center; flex:1; min-height:240px; color:${r.mutedForeground}; text-align:center; }
.sui-chat-message { display:grid; max-width:100%; animation:sui-chat-message-in 140ms ease-out both; }
.sui-chat-message[data-role='user'] { justify-items:end; }
.sui-chat-message[data-role='assistant'] { justify-items:start; }
.sui-chat-message[data-role='system'] { justify-items:center; }
.sui-chat-bubble { max-width:80%; padding:10px 14px; border-radius:${r.radiusBubble}; background:${r.secondary}; color:${r.secondaryForeground}; font-size:15px; line-height:1.5; white-space:normal; overflow-wrap:anywhere; }
.sui-chat-message[data-role='user'] .sui-chat-bubble { border-bottom-right-radius:${r.radiusControl}; background:${r.inverseBg}; color:${r.inverseText}; white-space:pre-wrap; }
.sui-chat-message[data-role='assistant'] .sui-chat-bubble { border-bottom-left-radius:${r.radiusControl}; }
.sui-chat-message[data-role='system'] .sui-chat-bubble { max-width:min(92%, 620px); border:1px solid ${r.border}; background:${r.glassStrong}; color:${r.mutedForeground}; font-size:13px; text-align:center; }
.sui-chat-message[data-variant='terminal'] .sui-chat-bubble { width:min(100%, 680px); max-width:96%; max-height:min(52vh, 520px); overflow:auto; border:1px solid ${r.border}; background:${r.codeBg}; color:${r.codeText}; font-family:${r.fontMono}; font-size:12px; line-height:1.5; white-space:pre; tab-size:4; }
.sui-chat-message[data-variant='terminal'] .sui-chat-bubble:focus-visible { ${P} }
.sui-chat-message-label, .sui-chat-message-meta { max-width:80%; padding:0 8px; color:${r.mutedForeground}; font-size:11px; line-height:1.4; }
.sui-chat-message-label { margin-bottom:4px; font-weight:650; }
.sui-chat-message-meta { margin-top:4px; }
.sui-chat-bubble > :first-child { margin-top:0; }
.sui-chat-bubble > :last-child { margin-bottom:0; }
.sui-chat-bubble-pending { display:inline-flex; align-items:center; padding:14px; }
.sui-chat-typing { display:inline-flex; align-items:center; gap:6px; }
.sui-chat-typing span { width:7px; height:7px; border-radius:${r.radiusFull}; background:${r.placeholder}; animation:sui-chat-typing 1.3s ease-in-out infinite; }
.sui-chat-typing span:nth-child(2) { animation-delay:.2s; }
.sui-chat-typing span:nth-child(3) { animation-delay:.4s; }
.sui-chat-composer { position:relative; display:grid; gap:12px; width:min(100%, 720px); margin:0 auto; padding:16px; border:1px solid ${r.border}; border-radius:${r.radiusBubble}; background:${r.glass}; -webkit-backdrop-filter:blur(20px) saturate(180%); backdrop-filter:blur(20px) saturate(180%); box-shadow:0 1px 2px rgb(${r.shadowRgb} / 0.04), 0 16px 40px rgb(${r.shadowRgb} / 0.10); transition:border-color .15s ease, box-shadow .15s ease; }
.sui-chat-composer:focus-within { border-color:color-mix(in srgb, ${r.primary} 32%, ${r.border}); box-shadow:0 0 0 4px color-mix(in srgb, ${r.primary} 12%, transparent), 0 1px 2px rgb(${r.shadowRgb} / 0.05), 0 20px 48px rgb(${r.shadowRgb} / 0.14); }
.sui-chat-composer[data-docked='true'] { position:fixed; right:24px; bottom:max(18px, env(safe-area-inset-bottom)); left:24px; z-index:40; }
.sui-chat-composer-input { width:100%; min-width:0; min-height:28px; max-height:160px; padding:2px 4px; resize:none; overflow-y:auto; border:0; outline:0; background:transparent; color:${r.foreground}; font:inherit; font-size:16px; line-height:1.5; }
.sui-chat-composer-input::placeholder { color:${r.placeholder}; }
.sui-chat-composer-input:disabled { cursor:not-allowed; opacity:.55; }
.sui-chat-composer-toolbar { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:12px; }
.sui-chat-composer-status { min-width:0; color:${r.mutedForeground}; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-chat-composer-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; flex:none; }
.sui-chat-composer-send { width:34px; height:34px; min-height:34px; border-radius:${r.radius}; font-size:18px; }
.sui-chat-composer-stop { width:34px; height:34px; min-height:34px; border-radius:${r.radius}; color:${r.destructive}; font-size:12px; }
.sui-chat-composer-stop:hover { background:${r.destructiveSoft}; color:${r.destructive}; }
@keyframes sui-chat-message-in { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
@keyframes sui-chat-typing { 0%, 60%, 100% { opacity:.3; } 30% { opacity:1; } }
@media (max-width: 620px) { .sui-chat-messages { padding:24px 14px 146px; } .sui-chat-bubble { max-width:90%; } .sui-chat-composer[data-docked='true'] { right:12px; left:12px; bottom:max(10px, env(safe-area-inset-bottom)); } }
`,_x=`
.sui-msg-scroller { position:relative; flex:1 1 auto; min-width:0; min-height:0; display:flex; flex-direction:column; }
.sui-msg-scroller-viewport { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; }
.sui-msg-scroller-viewport:focus-visible { ${P} }
.sui-msg-scroller-content { min-width:0; }
.sui-msg-scroller-jump { position:absolute; left:50%; bottom:14px; transform:translateX(-50%); z-index:5; width:32px; height:${r.controlHeight}; display:inline-flex; align-items:center; justify-content:center; border:1px solid ${r.border}; border-radius:${r.radiusFull}; background:${r.glassStrong}; color:${r.foreground}; font:inherit; cursor:pointer; box-shadow:0 1px 2px rgb(${r.shadowRgb} / 0.06), 0 8px 24px rgb(${r.shadowRgb} / 0.10); ${re} }
.sui-msg-scroller-jump:hover { background:${r.secondary}; }
.sui-msg-scroller-jump:focus-visible { ${P} }
.sui-scroll-fade[data-fade-top='true'][data-fade-bottom='false'] { mask-image:linear-gradient(to bottom, transparent, black 32px); -webkit-mask-image:linear-gradient(to bottom, transparent, black 32px); }
.sui-scroll-fade[data-fade-top='false'][data-fade-bottom='true'] { mask-image:linear-gradient(to bottom, black calc(100% - 32px), transparent); -webkit-mask-image:linear-gradient(to bottom, black calc(100% - 32px), transparent); }
.sui-scroll-fade[data-fade-top='true'][data-fade-bottom='true'] { mask-image:linear-gradient(to bottom, transparent, black 32px, black calc(100% - 32px), transparent); -webkit-mask-image:linear-gradient(to bottom, transparent, black 32px, black calc(100% - 32px), transparent); }
.sui-bubble { max-width:80%; padding:10px 14px; border-radius:${r.radiusBubble}; font-size:15px; line-height:1.5; overflow-wrap:anywhere; }
.sui-bubble[data-align='start'] { align-self:flex-start; }
.sui-bubble[data-align='end'] { align-self:flex-end; }
.sui-bubble[data-align='center'] { align-self:center; }
.sui-bubble-user { background:${r.inverseBg}; color:${r.inverseText}; white-space:pre-wrap; }
.sui-bubble-assistant { background:${r.secondary}; color:${r.secondaryForeground}; }
.sui-bubble-system { border:1px solid ${r.border}; background:${r.glassStrong}; color:${r.mutedForeground}; font-size:13px; text-align:center; }
.sui-bubble-content > :first-child { margin-top:0; }
.sui-bubble-content > :last-child { margin-bottom:0; }
.sui-bubble[data-expanded='false'] .sui-bubble-content { max-height:var(--sui-bubble-clamp, 320px); overflow:hidden; mask-image:linear-gradient(to bottom, black calc(100% - 32px), transparent); -webkit-mask-image:linear-gradient(to bottom, black calc(100% - 32px), transparent); }
.sui-bubble-toggle { display:inline-flex; align-items:center; justify-content:center; margin:8px auto 0; padding:4px 8px; border:1px solid ${r.border}; border-radius:${r.radiusControl}; background:${r.card}; color:${r.mutedForeground}; font:inherit; font-size:11px; font-weight:650; cursor:pointer; ${re} }
.sui-bubble-toggle:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-bubble-toggle:focus-visible { ${P} }
.sui-attachment { position:relative; display:grid; grid-template-columns:40px minmax(0, 1fr) auto; align-items:center; gap:10px; min-width:0; max-width:360px; padding:8px 10px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.foreground}; }
.sui-attachment-thumb { width:40px; height:40px; display:grid; place-items:center; overflow:hidden; border-radius:${r.radiusControl}; background:${r.secondary}; color:${r.mutedForeground}; }
.sui-attachment-thumb img { width:100%; height:100%; object-fit:cover; }
.sui-attachment-ext { max-width:100%; padding:0 4px; font-family:${r.fontMono}; font-size:10px; font-weight:650; overflow:hidden; text-overflow:ellipsis; }
.sui-attachment-details { min-width:0; display:grid; gap:4px; }
.sui-attachment-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:${r.fontSizeCompact}; font-weight:650; }
.sui-attachment-meta { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${r.mutedForeground}; font-size:11px; }
.sui-attachment-progress { position:relative; width:100%; height:3px; overflow:hidden; border-radius:${r.radiusFull}; background:color-mix(in srgb, ${r.primary} 14%, transparent); }
.sui-attachment-progress-bar { display:block; height:100%; border-radius:inherit; background:${r.primary}; }
.sui-attachment-progress-indeterminate { width:40%; animation:sui-attachment-indeterminate 1.2s ease-in-out infinite; }
.sui-attachment-remove { width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:18px; cursor:pointer; ${re} }
.sui-attachment-remove:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-attachment-remove:focus-visible { ${P} }
.sui-attachment[data-state='error'] .sui-attachment-name, .sui-attachment[data-state='error'] .sui-attachment-meta { color:${r.destructive}; }
.sui-marker { display:flex; align-items:center; gap:10px; min-width:0; color:${r.mutedForeground}; font-size:11px; }
.sui-marker-label { min-width:0; }
.sui-marker[data-variant='separator']::before, .sui-marker[data-variant='separator']::after { content:""; flex:1; height:1px; background:${r.border}; }
.sui-marker[data-variant='separator'] .sui-marker-label { flex:none; text-align:center; }
.sui-marker[data-variant='note'] { justify-content:center; }
.sui-marker[data-variant='note'] .sui-marker-label { max-width:100%; padding:4px 10px; border:1px solid ${r.border}; border-radius:${r.radiusFull}; background:${r.glassStrong}; text-align:center; }
.sui-marker[data-variant='status'] { justify-content:flex-start; }
.sui-shimmer { display:inline; }
.sui-shimmer[data-active='true'] { background:linear-gradient(90deg, ${r.mutedForeground} 35%, ${r.foreground} 50%, ${r.mutedForeground} 65%); background-size:200% 100%; background-clip:text; -webkit-background-clip:text; color:transparent; animation:sui-shimmer-sweep 2s linear infinite; }
@keyframes sui-attachment-indeterminate { from { transform:translateX(-100%); } to { transform:translateX(250%); } }
`,Mx=`
.sui-alert { min-width:0; display:grid; gap:4px; padding:12px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.mutedForeground}; font-size:13px; }
.sui-alert-title { color:${r.foreground}; font-size:13px; font-weight:650; }
.sui-alert-description { color:${r.mutedForeground}; line-height:1.45; }
.sui-alert-success { border-color:color-mix(in srgb, ${r.success} 45%, transparent); }
.sui-alert-success .sui-alert-title { color:${r.success}; }
.sui-alert-warning { border-color:color-mix(in srgb, ${r.warning} 45%, transparent); }
.sui-alert-warning .sui-alert-title { color:${r.warning}; }
.sui-alert-destructive { border-color:color-mix(in srgb, ${r.destructive} 45%, transparent); color:${r.destructive}; }
.sui-alert-destructive .sui-alert-title { color:${r.destructive}; }
.sui-alert-destructive .sui-alert-description { color:color-mix(in srgb, ${r.destructive} 80%, ${r.foreground}); }
`,Bx=`
.sui-table-container { min-width:0; width:100%; overflow-x:auto; }
.sui-table { width:100%; border-collapse:collapse; font-size:13px; }
.sui-table th, .sui-table td { padding:8px 10px; border-bottom:1px solid ${r.border}; text-align:left; vertical-align:top; }
.sui-table th { position:sticky; top:0; z-index:1; background:${r.card}; color:${r.mutedForeground}; font-size:11px; text-transform:uppercase; letter-spacing:.04em; font-weight:650; }
.sui-table caption { padding:8px 10px; color:${r.mutedForeground}; font-size:11px; text-align:left; caption-side:bottom; }
.sui-table tbody tr:hover { background:${r.hoverSubtle}; }
`,Hx=`
.sui-tabs { min-width:0; display:grid; align-content:start; gap:10px; }
.sui-tabs-list { display:flex; align-items:center; gap:2px; min-width:0; overflow-x:auto; border-bottom:1px solid ${r.border}; }
.sui-tabs-trigger { display:inline-flex; align-items:center; gap:6px; padding:8px 10px; border:none; border-bottom:2px solid transparent; margin-bottom:-1px; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:${r.fontSizeCompact}; font-weight:650; cursor:pointer; white-space:nowrap; ${re} }
.sui-tabs-trigger:hover { color:${r.foreground}; }
.sui-tabs-trigger:focus-visible { ${P} border-radius:${r.radiusControl}; }
.sui-tabs-trigger[data-state='active'] { color:${r.foreground}; border-bottom-color:${r.primary}; }
.sui-tabs-trigger:disabled { cursor:not-allowed; opacity:.45; }
.sui-tab-count { font-family:${r.fontMono}; font-size:10px; color:${r.mutedForeground}; border:1px solid ${r.border}; border-radius:${r.radiusFull}; padding:0 6px; min-width:18px; text-align:center; }
.sui-tabs-trigger[data-state='active'] .sui-tab-count { color:${r.primary}; border-color:color-mix(in srgb, ${r.primary} 33%, transparent); }
.sui-tabs-content { min-width:0; }
.sui-tabs-content:focus-visible { outline:none; }
`,Nx=`
.sui-dialog-overlay { position:fixed; inset:0; z-index:50; background:color-mix(in srgb, rgb(${r.shadowRgb}) 45%, transparent); -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px); }
.sui-dialog-content { position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); z-index:50; display:grid; gap:10px; width:calc(100vw - 32px); max-width:480px; max-height:calc(100vh - 48px); overflow:auto; padding:16px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; box-shadow:${Fg}; }
.sui-dialog-header { min-width:0; display:grid; gap:4px; padding-right:28px; }
.sui-dialog-title { color:${r.cardForeground}; font-size:13px; font-weight:650; }
.sui-dialog-description { color:${r.mutedForeground}; font-size:${r.fontSizeCompact}; line-height:1.45; }
.sui-dialog-footer { display:flex; align-items:center; justify-content:flex-end; gap:8px; flex-wrap:wrap; }
.sui-dialog-close { position:absolute; top:10px; right:10px; display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; cursor:pointer; ${re} }
.sui-dialog-close:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-dialog-close:focus-visible { ${P} }
`,Dx=`
.sui-tooltip-content { z-index:60; max-width:320px; padding:4px 8px; border-radius:${r.radiusControl}; background:${r.inverseBg}; color:${r.inverseText}; font-size:11px; line-height:1.4; box-shadow:${wi}; }
`,Ux=`
.sui-plan { min-width:0; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; overflow:hidden; }
.sui-plan-header { min-width:0; display:flex; align-items:center; gap:10px; padding:8px 10px; }
.sui-plan-trigger { min-width:0; min-height:28px; flex:1 1 auto; display:flex; align-items:center; gap:8px; margin:-4px; padding:4px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.foreground}; font:inherit; text-align:left; cursor:pointer; ${re} }
.sui-plan-trigger:hover { background:${r.secondary}; }
.sui-plan-trigger:focus-visible { ${P} }
.sui-plan-chevron { display:inline-flex; align-items:center; justify-content:center; width:12px; flex:none; color:${r.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-plan-trigger[aria-expanded='true'] .sui-plan-chevron { transform:rotate(90deg); }
.sui-plan-title { min-width:0; font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-plan-title[data-shimmer='true'] { background:linear-gradient(90deg, ${r.mutedForeground} 35%, ${r.foreground} 50%, ${r.mutedForeground} 65%); background-size:200% 100%; background-clip:text; -webkit-background-clip:text; color:transparent; animation:sui-shimmer-sweep 2s linear infinite; }
.sui-plan-summary { flex:none; color:${r.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-plan-steps { display:grid; gap:0; margin:0; padding:0 10px 10px; list-style:none; }
.sui-plan-step { position:relative; min-width:0; border-top:1px solid ${r.border}; }
.sui-plan-step-row { min-width:0; display:grid; grid-template-columns:10px minmax(0, 1fr) auto; align-items:center; gap:8px; min-height:36px; }
.sui-plan-step-dot, .sui-taskitem-dot { width:7px; height:7px; flex:none; border-radius:${r.radiusFull}; background:color-mix(in srgb, ${r.mutedForeground} 40%, transparent); }
.sui-plan-step[data-status-class='run'] .sui-plan-step-dot { background:${Y.run}; }
.sui-plan-step[data-status-class='ok'] .sui-plan-step-dot { background:${Y.ok}; }
.sui-plan-step[data-status-class='warn'] .sui-plan-step-dot { background:${Y.warn}; }
.sui-plan-step[data-status-class='bad'] .sui-plan-step-dot { background:${Y.bad}; }
.sui-plan-step[data-status-class='muted'] .sui-plan-step-dot { background:${Y.muted}; }
.sui-plan-step-label { min-width:0; color:${r.foreground}; font-size:13px; line-height:1.4; overflow-wrap:anywhere; }
.sui-plan-step[data-status='skipped'] .sui-plan-step-label { color:${r.mutedForeground}; text-decoration:line-through; }
.sui-plan-step-toggle { min-height:24px; padding:2px 6px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:11px; cursor:pointer; ${re} }
.sui-plan-step-toggle:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-plan-step-toggle:focus-visible { ${P} }
.sui-plan-step-detail { min-width:0; margin:0 0 8px 18px; padding:8px 10px; border-radius:${r.radiusControl}; background:${r.surface2}; color:${r.mutedForeground}; font-size:12px; line-height:1.45; }
.sui-taskitem { min-width:0; display:flex; align-items:center; gap:8px; padding:8px 10px; color:${r.foreground}; font-size:${r.fontSizeCompact}; }
.sui-taskitem-run .sui-taskitem-dot { background:${Y.run}; }
.sui-taskitem-ok .sui-taskitem-dot { background:${Y.ok}; }
.sui-taskitem-warn .sui-taskitem-dot { background:${Y.warn}; }
.sui-taskitem-bad .sui-taskitem-dot { background:${Y.bad}; }
.sui-taskitem-muted .sui-taskitem-dot { background:${Y.muted}; }
.sui-taskitem-label { min-width:0; flex:1 1 auto; overflow-wrap:anywhere; }
.sui-taskitem-files { min-width:0; display:flex; align-items:center; justify-content:flex-end; gap:4px; flex-wrap:wrap; }
.sui-taskitem-file { max-width:180px; padding:2px 6px; border:1px solid ${r.border}; border-radius:${r.radiusFull}; background:${r.hoverSubtle}; color:${r.mutedForeground}; font-family:${r.fontMono}; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-taskitem-elapsed { flex:none; color:${r.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-sources { min-width:0; color:${r.mutedForeground}; font-size:12px; }
.sui-sources-trigger { min-height:28px; display:inline-flex; align-items:center; gap:6px; padding:4px 6px; border:1px solid transparent; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:12px; cursor:pointer; ${re} }
.sui-sources-trigger:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-sources-trigger:focus-visible { ${P} }
.sui-sources-list { display:grid; gap:6px; margin:4px 0 0; padding:8px 8px 8px 28px; border-left:1px solid ${r.border}; list-style:decimal; }
.sui-sources-item { min-width:0; padding-left:2px; }
.sui-sources-link { color:${r.primary}; text-decoration:underline; text-underline-offset:2px; overflow-wrap:anywhere; }
.sui-sources-link:hover { text-decoration-thickness:2px; }
.sui-sources-link:focus-visible { ${P} }
.sui-sources-label { color:${r.mutedForeground}; overflow-wrap:anywhere; }
.sui-citation { line-height:0; }
.sui-citation > a, .sui-citation > button { display:inline-flex; align-items:center; justify-content:center; margin:0 1px; padding:2px 4px; border:1px solid color-mix(in srgb, ${r.primary} 33%, transparent); border-radius:${r.radiusFull}; background:color-mix(in srgb, ${r.primary} 10%, transparent); color:${r.primary}; font:inherit; font-size:10px; font-weight:650; line-height:1.2; text-decoration:none; vertical-align:super; cursor:pointer; }
.sui-citation > a:hover, .sui-citation > button:hover { background:color-mix(in srgb, ${r.primary} 16%, transparent); }
.sui-citation > a:focus-visible, .sui-citation > button:focus-visible { ${P} }
`,jx=`
.sui-select-trigger { min-width:0; min-height:${r.controlHeight}; display:inline-flex; align-items:center; justify-content:space-between; gap:8px; padding:0 10px; border:1px solid ${r.input}; border-radius:${r.radiusControl}; background:${r.card}; color:${r.foreground}; font:inherit; font-size:13px; cursor:pointer; white-space:nowrap; ${re} }
.sui-select-trigger:hover { background:${r.secondary}; }
.sui-select-trigger:focus-visible { ${P} }
.sui-select-trigger:disabled { cursor:not-allowed; opacity:.45; }
.sui-select-trigger[data-placeholder] { color:${r.placeholder}; }
.sui-select-icon { color:${r.mutedForeground}; flex:none; }
.sui-select-content { z-index:60; min-width:var(--radix-select-trigger-width, 8rem); max-height:var(--radix-select-content-available-height, 320px); overflow:hidden; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.popover}; color:${r.popoverForeground}; box-shadow:${Fg}; }
.sui-select-viewport { padding:4px; }
.sui-select-item { position:relative; display:flex; align-items:center; gap:6px; padding:6px 8px 6px 26px; border-radius:${r.radiusControl}; color:${r.foreground}; font-size:13px; cursor:pointer; user-select:none; outline:none; ${re} }
.sui-select-item[data-highlighted] { background:${r.secondary}; }
.sui-select-item[data-disabled] { opacity:.45; cursor:not-allowed; }
.sui-select-item-indicator { position:absolute; left:7px; display:inline-flex; align-items:center; color:${r.primary}; }
.sui-select-label { padding:6px 8px; color:${r.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-select-separator { height:1px; margin:4px 0; background:${r.border}; }
.sui-select-scroll-button { display:flex; align-items:center; justify-content:center; height:20px; color:${r.mutedForeground}; cursor:default; }
`,Lx=`
.sui-progress { position:relative; width:100%; height:6px; overflow:hidden; border-radius:${r.radiusFull}; background:${r.secondary}; }
.sui-progress-indicator { width:100%; height:100%; border-radius:${r.radiusFull}; background:${r.primary}; transition:transform .3s ease; }
`,qx=`
.sui-skeleton { display:block; min-height:14px; border-radius:${r.radiusControl}; background:color-mix(in srgb, ${r.mutedForeground} 14%, transparent); animation:sui-skeleton-pulse 1.6s ease-in-out infinite; }
@keyframes sui-skeleton-pulse { 0%, 100% { opacity:1; } 50% { opacity:.45; } }
`,Fx=`
.sui-spinner { display:inline-block; width:14px; height:14px; flex:none; border:2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color:currentColor; border-radius:${r.radiusFull}; animation:sui-spin .7s linear infinite; }
.sui-spinner-sm { width:11px; height:11px; border-width:1.5px; }
.sui-spinner-lg { width:20px; height:20px; }
@keyframes sui-spin { to { transform:rotate(360deg); } }
`,Gx=`
.sui-separator { flex:none; background:${r.border}; }
.sui-separator[data-orientation='horizontal'] { height:1px; width:100%; }
.sui-separator[data-orientation='vertical'] { width:1px; align-self:stretch; }
`,Vx=`
.sui-relative-time { font-variant-numeric:tabular-nums; }
`,Yx=`
.sui-empty { min-width:0; display:grid; justify-items:center; gap:6px; padding:24px; color:${r.mutedForeground}; text-align:center; }
.sui-empty-icon { color:${r.textFaint}; }
.sui-empty-title { color:${r.foreground}; font-size:13px; font-weight:650; }
.sui-empty-description { color:${r.mutedForeground}; font-size:${r.fontSizeCompact}; line-height:1.45; max-width:420px; }
.sui-empty-action { margin-top:6px; }
`,Kx=`
.sui-section-header { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:10px; }
.sui-section-header-main { min-width:0; display:grid; gap:2px; }
.sui-section-header-title { min-width:0; color:${r.foreground}; font-size:13px; font-weight:650; }
.sui-section-header-actions { display:flex; align-items:center; gap:8px; flex:none; }
.sui-eyebrow { color:${r.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
`,Px=`
.sui-row-button { min-width:0; display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; padding:10px 12px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.foreground}; font:inherit; font-size:13px; text-align:left; cursor:pointer; box-shadow:${r.shadow1}; ${re} }
.sui-row-button:hover { background:${r.secondary}; }
.sui-row-button:active:not(:disabled) { background:color-mix(in srgb, ${r.foreground} 6%, ${r.secondary}); }
.sui-row-button:focus-visible { ${P} }
.sui-row-button[data-active='true'] { background:${r.secondary}; border-color:color-mix(in srgb, ${r.primary} 40%, transparent); box-shadow:inset 2px 0 0 ${r.primary}, ${r.shadow1}; }
.sui-row-button:disabled { cursor:not-allowed; opacity:.45; }
`,Xx=`
.sui-kpi { min-width:0; display:grid; gap:4px; padding:14px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; box-shadow:${wi}; }
/* The KPI numeral is the one sanctioned 700 weight in the system. */
.sui-kpi-value { color:${r.foreground}; font-size:20px; font-weight:700; font-variant-numeric:tabular-nums; }
.sui-kpi-label { color:${r.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-kpi-hint { color:${r.textFaint}; font-size:11px; }
`,Qx=`
.sui-collapsible { min-width:0; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; box-shadow:${wi}; overflow:hidden; }
.sui-collapsible-header { min-width:0; display:flex; align-items:center; gap:10px; padding:12px 14px; cursor:pointer; user-select:none; ${re} }
.sui-collapsible-header:hover { background:${r.secondary}; }
.sui-collapsible-header:focus-visible { outline:none; box-shadow:inset 0 0 0 2px ${r.ringBorder}; }
.sui-collapsible-heading { min-width:0; flex:1; display:flex; align-items:center; gap:8px; }
.sui-collapsible-title { min-width:0; color:${r.cardForeground}; font-size:13px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-collapsible-meta { flex:none; color:${r.mutedForeground}; font-size:11px; }
.sui-collapsible-toggle { flex:none; color:${r.mutedForeground}; font-size:11px; }
.sui-collapsible-body { min-width:0; display:grid; align-content:start; gap:8px; padding:0 14px 14px; }
.sui-collapsible-empty { color:${r.mutedForeground}; font-size:${r.fontSizeCompact}; line-height:1.45; padding:0 14px 14px; }
`,Ix=`
.sui-diff { border:1px solid ${r.border}; border-radius:${r.radius}; overflow:hidden; font:500 12px/1.7 ${r.fontMono}; }
.sui-diff-line { display:flex; padding:0 10px; }
.sui-diff-line.sui-diff-add { background:color-mix(in srgb, ${r.success} 10%, ${r.card}); color:color-mix(in srgb, ${r.success} 80%, ${r.foreground}); }
.sui-diff-line.sui-diff-del { background:color-mix(in srgb, ${r.destructive} 9%, ${r.card}); color:color-mix(in srgb, ${r.destructive} 80%, ${r.foreground}); }
.sui-diff-ln { flex:none; width:34px; padding-right:12px; text-align:right; color:${r.placeholder}; user-select:none; }
.sui-diff-ln-old, .sui-diff-ln-new { width:30px; }
.sui-diff-sign { flex:none; width:14px; }
.sui-diff-text { white-space:pre; overflow-x:auto; }
.sui-diff-hunk-head { display:flex; align-items:center; gap:8px; padding:2px 10px; background:color-mix(in srgb, ${r.primary} 7%, ${r.card}); color:color-mix(in srgb, ${r.primary} 80%, ${r.mutedForeground}); border-top:1px solid ${r.border}; }
.sui-diff-hunk-gutter { flex:none; width:60px; text-align:center; color:${r.placeholder}; user-select:none; }
.sui-diff-hunk-header { white-space:pre; overflow-x:auto; }
.sui-diff-paginate { display:grid; place-items:center; padding:8px; border-top:1px solid ${r.border}; }
.sui-diff-paginate-btn { padding:6px 12px; border:1px solid ${r.border}; border-radius:${r.radiusControl}; background:${r.card}; color:${r.primary}; font:650 12px/1 ${r.fontSans}; cursor:pointer; ${re} }
.sui-diff-paginate-btn:hover { background:${r.secondary}; }
`,Zx=`
.sui-file-tree { min-width:0; display:flex; flex-direction:column; gap:1px; font-size:13px; color:${r.foreground}; }
.sui-file-tree-children { display:flex; flex-direction:column; gap:1px; margin-left:10px; padding-left:8px; border-left:1px solid ${r.border}; }
.sui-file-tree-dir { min-width:0; display:flex; flex-direction:column; gap:1px; }
.sui-file-tree-dir-toggle { min-width:0; display:flex; align-items:center; gap:6px; width:100%; padding:4px 6px; border:none; border-radius:${r.radiusControl}; background:transparent; color:${r.mutedForeground}; font:inherit; font-size:${r.fontSizeCompact}; font-weight:650; text-align:left; cursor:pointer; ${re} }
.sui-file-tree-dir-toggle:hover { background:${r.secondary}; color:${r.foreground}; }
.sui-file-tree-dir-toggle:focus-visible { ${P} }
.sui-file-tree-caret { flex:none; width:0; height:0; border-top:4px solid transparent; border-bottom:4px solid transparent; border-left:5px solid currentColor; transform:rotate(90deg); transition:transform .12s ease; }
.sui-file-tree-dir-toggle[aria-expanded='false'] .sui-file-tree-caret { transform:rotate(0deg); }
.sui-file-tree-dir-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-file-tree-row { min-width:0; display:flex; align-items:center; gap:4px; }
.sui-file-tree-file { min-width:0; flex:1 1 auto; display:flex; align-items:center; gap:6px; padding:4px 6px; border:none; border-radius:${r.radiusControl}; background:transparent; color:${r.foreground}; font:inherit; font-size:13px; text-align:left; cursor:pointer; ${re} }
.sui-file-tree-file:hover { background:${r.secondary}; }
.sui-file-tree-file:focus-visible { ${P} }
.sui-file-tree-file[data-active='true'] { background:color-mix(in srgb, ${r.primary} 12%, transparent); color:${r.primary}; font-weight:650; }
.sui-file-tree-file-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sui-file-tree-affordance { flex:none; display:inline-flex; align-items:center; }
`,Wx=`
.sui-md { min-width:0; color:${r.foreground}; font-size:13px; line-height:1.55; overflow-wrap:anywhere; }
.sui-md > :first-child { margin-top:0; }
.sui-md > :last-child { margin-bottom:0; }
.sui-md-p { margin:6px 0; }
.sui-md-heading { margin:14px 0 6px; color:${r.foreground}; font-weight:650; line-height:1.3; }
.sui-md-h1 { font-size:1.5em; }
.sui-md-h2 { font-size:1.3em; }
.sui-md-h3 { font-size:1.15em; }
.sui-md-h4 { font-size:1em; }
.sui-md-h5 { font-size:.9em; }
.sui-md-h6 { font-size:.85em; color:${r.mutedForeground}; }
.sui-md-list { margin:6px 0; padding-left:22px; }
.sui-md-list li { margin:2px 0; }
.sui-md-inline-code { padding:2px 6px; border-radius:${r.radiusControl}; background:color-mix(in srgb, ${r.foreground} 7%, transparent); font-family:${r.fontMono}; font-size:.9em; }
.sui-md-link { color:${r.primary}; text-decoration:underline; text-underline-offset:2px; cursor:pointer; }
.sui-md-link:hover { text-decoration-thickness:2px; }
`,Jx=`
.sui-response { min-width:0; }
.sui-response-caret { display:inline-block; width:7px; height:14px; margin-left:2px; vertical-align:text-bottom; border-radius:2px; background:${r.mutedForeground}; animation:sui-caret-blink 1s steps(2, jump-none) infinite; }
@keyframes sui-caret-blink { 50% { opacity:0; } }
.sui-codeblock { margin:8px 0; border-radius:${r.radius}; background:${r.codeBg}; color:${r.codeText}; overflow:hidden; }
.sui-codeblock-header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 10px; border-bottom:1px solid color-mix(in srgb, ${r.codeText} 12%, transparent); }
.sui-codeblock-lang { font-family:${r.fontMono}; font-size:11px; color:color-mix(in srgb, ${r.codeText} 70%, transparent); text-transform:lowercase; }
.sui-codeblock-actions { display:inline-flex; align-items:center; gap:6px; margin-left:auto; }
.sui-codeblock-action { min-height:24px; padding:0 8px; border:1px solid color-mix(in srgb, ${r.codeText} 16%, transparent); border-radius:${r.radiusControl}; background:transparent; color:color-mix(in srgb, ${r.codeText} 76%, transparent); font:inherit; font-size:11px; cursor:pointer; ${re} }
.sui-codeblock-action:hover { background:color-mix(in srgb, ${r.codeText} 9%, transparent); color:${r.codeText}; }
.sui-codeblock-action:focus-visible { ${P} }
.sui-codeblock-body { margin:0; padding:12px 14px; font-family:${r.fontMono}; font-size:12px; line-height:1.5; overflow:auto; tab-size:4; }
.sui-codeblock-body:focus-visible { ${P} }
.sui-codeblock-body code { display:block; min-width:max-content; white-space:pre; font:inherit; color:inherit; }
.sui-codeblock[data-wrap='true'] .sui-codeblock-body code { min-width:0; white-space:pre-wrap; overflow-wrap:anywhere; }
.sui-codeblock-lineno { display:inline-block; min-width:2.5em; padding-right:12px; text-align:right; color:color-mix(in srgb, ${r.codeText} 40%, transparent); user-select:none; }
`,ev=`
.sui-agent-output { min-width:0; display:grid; align-content:start; gap:10px; }
.sui-agent-output-tools { min-width:0; display:grid; align-content:start; gap:8px; }
`,tv=`
.sui-pierre-diff-frame { min-width:0; border-radius:${r.radius}; background:${r.card}; color:${r.foreground}; }
.sui-pierre-diff { --diffs-font-family:${r.fontMono}; --diffs-header-font-family:${r.fontSans}; --diffs-light-bg:${r.card}; --diffs-dark-bg:${r.card}; --diffs-light:${r.foreground}; --diffs-dark:${r.foreground}; --diffs-addition-color:${r.success}; --diffs-deletion-color:${r.destructive}; --diffs-bg-addition-override:${r.successSoft}; --diffs-bg-deletion-override:${r.destructiveSoft}; --diffs-bg-context-override:${r.surface2}; --diffs-bg-separator-override:${r.surface2}; --diffs-fg-number-override:${r.mutedForeground}; display:block; min-width:0; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.foreground}; overflow:hidden; }
.sui-pierre-diff-empty { padding:24px; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; text-align:center; color:${r.mutedForeground}; font-size:13px; }
.sui-pierre-diff-stat { font-family:${r.fontMono}; font-size:11px; color:${r.mutedForeground}; }
.sui-pierre-diff-stat-add { color:${r.success}; }
.sui-pierre-diff-stat-del { color:${r.destructive}; }
`,nv=`
.sui-stage-strip { min-width:0; display:grid; gap:8px; }
.sui-stage-strip-summary { display:flex; align-items:baseline; gap:6px; min-width:0; }
.sui-stage-strip-summary-label { color:${r.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-stage-strip-summary-count { color:${r.foreground}; font-size:12px; font-variant-numeric:tabular-nums; }
.sui-stage-strip-chips { display:flex; align-items:center; flex-wrap:wrap; gap:8px; min-width:0; }
.sui-stage-chip { flex:0 0 auto; text-transform:none; letter-spacing:0; }
`,av=`
.sui-reasoning { min-width:0; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; overflow:hidden; }
.sui-reasoning-trigger { width:100%; min-width:0; display:flex; align-items:center; gap:8px; padding:10px 14px; border:0; background:transparent; color:${r.foreground}; font:inherit; text-align:left; cursor:pointer; ${re} }
.sui-reasoning-trigger:hover { background:${r.secondary}; }
.sui-reasoning-trigger:focus-visible { ${P} }
.sui-reasoning-chevron { flex:none; display:inline-block; color:${r.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-reasoning-trigger[aria-expanded='true'] .sui-reasoning-chevron { transform:rotate(90deg); }
.sui-reasoning-title { min-width:0; flex:1; font-size:13px; font-weight:650; }
.sui-reasoning-duration { flex:none; color:${r.mutedForeground}; font-size:11px; font-variant-numeric:tabular-nums; }
.sui-reasoning-body { min-width:0; padding:0 14px 12px; color:${r.mutedForeground}; font-size:13px; line-height:1.5; }
.sui-reasoning-title[data-shimmer='true'], .sui-cot-title[data-shimmer='true'] { background:linear-gradient(90deg, ${r.mutedForeground} 35%, ${r.foreground} 50%, ${r.mutedForeground} 65%); background-size:200% 100%; background-clip:text; -webkit-background-clip:text; color:transparent; animation:sui-shimmer-sweep 2s linear infinite; }

.sui-cot { min-width:0; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; overflow:hidden; }
.sui-cot-trigger { width:100%; min-width:0; display:flex; align-items:center; gap:8px; padding:10px 14px; border:0; background:transparent; color:${r.foreground}; font:inherit; text-align:left; cursor:pointer; ${re} }
.sui-cot-trigger:hover { background:${r.secondary}; }
.sui-cot-trigger:focus-visible { ${P} }
.sui-cot-chevron { flex:none; display:inline-block; color:${r.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-cot-trigger[aria-expanded='true'] .sui-cot-chevron { transform:rotate(90deg); }
.sui-cot-title { min-width:0; flex:1; font-size:13px; font-weight:650; }
.sui-cot-body { min-width:0; padding:0 14px 12px; }
.sui-cot-steps { display:grid; gap:8px; margin:0; padding:0; list-style:none; }
.sui-cot-step { position:relative; min-width:0; display:grid; grid-template-columns:12px minmax(0, 1fr); column-gap:8px; align-items:start; color:${r.foreground}; font-size:13px; line-height:1.45; }
.sui-cot-step::before { content:""; position:absolute; left:5px; top:13px; bottom:-9px; border-left:1px solid ${r.border}; }
.sui-cot-step:last-child::before { display:none; }
.sui-cot-step-dot { position:relative; z-index:1; width:10px; height:10px; margin-top:4px; border:2px solid ${r.card}; border-radius:${r.radiusFull}; background:color-mix(in srgb, ${r.mutedForeground} 40%, transparent); }
.sui-cot-step[data-status-class='run'] .sui-cot-step-dot { background:${Y.run}; }
.sui-cot-step[data-status-class='ok'] .sui-cot-step-dot { background:${Y.ok}; }
.sui-cot-step[data-status-class='warn'] .sui-cot-step-dot { background:${Y.warn}; }
.sui-cot-step[data-status-class='bad'] .sui-cot-step-dot { background:${Y.bad}; }
.sui-cot-step[data-status-class='muted'] .sui-cot-step-dot { background:${Y.muted}; }
.sui-cot-step-label { min-width:0; overflow-wrap:anywhere; }
.sui-cot-step-detail { grid-column:2; min-width:0; margin-top:2px; color:${r.mutedForeground}; font-size:12px; overflow-wrap:anywhere; }

.sui-toolcall { min-width:0; border:1px solid ${r.border}; border-radius:${r.radius}; background:${r.card}; color:${r.cardForeground}; overflow:hidden; }
.sui-toolcall-trigger, .sui-toolcall-header { width:100%; min-width:0; display:flex; align-items:center; gap:8px; padding:8px 12px; }
.sui-toolcall-trigger { border:0; background:transparent; color:${r.foreground}; font:inherit; text-align:left; cursor:pointer; ${re} }
.sui-toolcall-trigger:hover { background:${r.secondary}; }
.sui-toolcall-trigger:focus-visible { ${P} }
.sui-toolcall-header { background:${r.secondary}; }
.sui-toolcall-chevron { flex:none; display:inline-block; color:${r.mutedForeground}; font-size:18px; line-height:1; transform:rotate(0deg); transition:transform .12s ease; }
.sui-toolcall-trigger[aria-expanded='true'] .sui-toolcall-chevron { transform:rotate(90deg); }
.sui-toolcall-name { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:${r.fontMono}; font-size:${r.fontSizeCompact}; }
.sui-toolcall-approval { min-width:0; padding:10px 12px; border-top:1px solid ${r.border}; }
.sui-toolcall-body { min-width:0; display:grid; gap:10px; padding:10px 12px 12px; border-top:1px solid ${r.border}; }
.sui-toolcall-section { min-width:0; display:grid; gap:6px; }
.sui-toolcall-section-title { color:${r.mutedForeground}; font-size:11px; font-weight:650; text-transform:uppercase; letter-spacing:.05em; }
.sui-toolcall-pre { margin:0; padding:10px 12px; border-radius:${r.radiusControl}; background:${r.codeBg}; color:${r.codeText}; font-family:${r.fontMono}; font-size:12px; line-height:1.5; white-space:pre-wrap; overflow:auto; max-height:320px; }
.sui-toolcall-pre:focus-visible { ${P} }
.sui-toolcall-error { color:${r.destructive}; }
.sui-toolcall[data-layout='expanded'] .sui-toolcall-body { border-top:0; }
`,Gg=[Ex,Cx,Ax,Ox,Rx,zx,_x,Mx,Bx,Hx,Nx,Dx,Ux,jx,Lx,qx,Fx,Gx,Vx,Yx,Kx,Px,Xx,Qx,Ix,Zx,Wx,Jx,ev,tv,nv,av,Rg,zg,_g,Mg,Bg,Hg,Ng,Dg,Ug,jg,Lg,qg,Tx].map(e=>e.trim()).join(`
`);var iv=X(he(),1);var Pg="data-smithers-ui";function at(){(0,Xg.useInsertionEffect)(()=>{if(typeof document>"u"||document.querySelector(`style[${Pg}]`))return;let e=document.createElement("style");e.setAttribute(Pg,""),e.textContent=Gg,document.head.appendChild(e)},[])}var Qg=e=>typeof e=="boolean"?`${e}`:e===0?"0":e,Ig=gi,Ra=(e,t)=>n=>{var a;if(t?.variants==null)return Ig(e,n?.class,n?.className);let{variants:o,defaultVariants:i}=t,s=Object.keys(o).map(c=>{let m=n?.[c],b=i?.[c];if(m===null)return null;let f=Qg(m)||Qg(b);return o[c][f]}),l=n&&Object.entries(n).reduce((c,m)=>{let[b,f]=m;return f===void 0||(c[b]=f),c},{}),u=t==null||(a=t.compoundVariants)===null||a===void 0?void 0:a.reduce((c,m)=>{let{class:b,className:f,...h}=m;return Object.entries(h).every(w=>{let[$,B]=w;return Array.isArray(B)?B.includes({...i,...l}[$]):{...i,...l}[$]===B})?[...c,b,f]:c},[]);return Ig(e,s,u,n?.class,n?.className)};var za={};Ah(za,{Root:()=>lv,Slot:()=>lv,Slottable:()=>uv,createSlot:()=>th,createSlottable:()=>ah});var we=X(mt(),1);var Wg=X(mt(),1);function Zg(e,t){if(typeof e=="function")return e(t);e!=null&&(e.current=t)}function sv(...e){return t=>{let n=!1,a=e.map(o=>{let i=Zg(o,t);return!n&&typeof i=="function"&&(n=!0),i});if(n)return()=>{for(let o=0;o<a.length;o++){let i=a[o];typeof i=="function"?i():Zg(e[o],null)}}}}function Jg(...e){return Wg.useCallback(sv(...e),e)}function th(e){let t=we.forwardRef((n,a)=>{let{children:o,...i}=n,s=null,l=!1,u=[];eh(o)&&typeof ki=="function"&&(o=ki(o._payload)),we.Children.forEach(o,f=>{if(fv(f)){l=!0;let h=f,w="child"in h.props?h.props.child:h.props.children;eh(w)&&typeof ki=="function"&&(w=ki(w._payload)),s=dv(h,w),u.push(s?.props?.children)}else u.push(f)}),s?s=we.cloneElement(s,void 0,u):!l&&we.Children.count(o)===1&&we.isValidElement(o)&&(s=o);let c=s?pv(s):void 0,m=Jg(a,c);if(!s){if(o||o===0)throw new Error(l?bv(e):mv(e));return o}let b=cv(i,s.props??{});return s.type!==we.Fragment&&(b.ref=a?m:c),we.cloneElement(s,b)});return t.displayName=`${e}.Slot`,t}var lv=th("Slot"),nh=Symbol.for("radix.slottable");function ah(e){let t=n=>"child"in n?n.children(n.child):n.children;return t.displayName=`${e}.Slottable`,t.__radixId=nh,t}var uv=ah("Slottable"),dv=(e,t)=>{if("child"in e.props){let n=e.props.child;return we.isValidElement(n)?we.cloneElement(n,void 0,e.props.children(n.props.children)):null}return we.isValidElement(t)?t:null};function cv(e,t){let n={...t};for(let a in t){let o=e[a],i=t[a];/^on[A-Z]/.test(a)?o&&i?n[a]=(...l)=>{let u=i(...l);return o(...l),u}:o&&(n[a]=o):a==="style"?n[a]={...o,...i}:a==="className"&&(n[a]=[o,i].filter(Boolean).join(" "))}return{...e,...n}}function pv(e){let t=Object.getOwnPropertyDescriptor(e.props,"ref")?.get,n=t&&"isReactWarning"in t&&t.isReactWarning;return n?e.ref:(t=Object.getOwnPropertyDescriptor(e,"ref")?.get,n=t&&"isReactWarning"in t&&t.isReactWarning,n?e.props.ref:e.props.ref||e.ref)}function fv(e){return we.isValidElement(e)&&typeof e.type=="function"&&"__radixId"in e.type&&e.type.__radixId===nh}var gv=Symbol.for("react.lazy");function eh(e){return e!=null&&typeof e=="object"&&"$$typeof"in e&&e.$$typeof===gv&&"_payload"in e&&hv(e._payload)}function hv(e){return typeof e=="object"&&e!==null&&"then"in e}var mv=e=>`${e} failed to slot onto its children. Expected a single React element child or \`Slottable\`.`,bv=e=>`${e} failed to slot onto its \`Slottable\`. Expected \`Slottable\` to receive a single React element child.`,ki=we[" use ".trim().toString()];var rh=X(he(),1),xv=Ra("sui-spinner",{variants:{size:{sm:"sui-spinner-sm",default:"",lg:"sui-spinner-lg"}},defaultVariants:{size:"default"}});function oh({className:e,size:t,"aria-label":n,...a}){return at(),(0,rh.jsx)("span",{"data-slot":"spinner",role:"status","aria-label":n??"Loading",className:Ce(xv({size:t}),e),...a})}var No=X(he(),1),ih=Ra("sui-button",{variants:{variant:{default:"sui-button-default",solid:"sui-button-solid",secondary:"sui-button-secondary",outline:"sui-button-outline",ghost:"sui-button-ghost",destructive:"sui-button-destructive",link:"sui-button-link"},size:{sm:"sui-button-sm",default:"",lg:"sui-button-lg",icon:"sui-button-icon-size"}},defaultVariants:{variant:"default",size:"default"}});function xu({className:e,variant:t,size:n,asChild:a=!1,loading:o=!1,type:i,disabled:s,children:l,...u}){at();let c=Ce(ih({variant:t,size:n}),e),m=s||o;if(a){let b={disabled:m||void 0,"aria-disabled":m?!0:void 0,"aria-busy":o?!0:void 0};return(0,No.jsx)(za.Root,{"data-slot":"button",className:c,...b,...u,children:l})}return(0,No.jsxs)("button",{"data-slot":"button",type:i??"button",className:c,disabled:m,"aria-busy":o?!0:void 0,...u,children:[o?(0,No.jsx)(oh,{size:"sm","aria-hidden":"true"}):null,l]})}var lh=X(he(),1),sh=Ra("sui-badge",{variants:{variant:{default:"sui-badge-default",secondary:"sui-badge-secondary",outline:"sui-badge-outline",success:"sui-badge-success",warning:"sui-badge-warning",destructive:"sui-badge-destructive",muted:"sui-badge-muted"}},defaultVariants:{variant:"default"}});function $i({className:e,variant:t,asChild:n=!1,...a}){at();let o=n?za.Root:"span";return(0,lh.jsx)(o,{"data-slot":"badge",className:Ce(sh({variant:t}),e),...a})}var Do=X(he(),1);function Ti({className:e,...t}){return at(),(0,Do.jsx)("section",{"data-slot":"card",className:Ce("sui-card",e),...t})}function Ei({className:e,...t}){return(0,Do.jsx)("div",{"data-slot":"card-header",className:Ce("sui-card-header",e),...t})}function Ci({className:e,...t}){return(0,Do.jsx)("h2",{"data-slot":"card-title",className:Ce("sui-card-title",e),...t})}function Ai({className:e,...t}){return(0,Do.jsx)("div",{"data-slot":"card-content",className:Ce("sui-card-content",e),...t})}var Bn=X(he(),1);function vu({icon:e,title:t,description:n,action:a,className:o,children:i,...s}){return at(),(0,Bn.jsxs)("div",{"data-slot":"empty-state",className:Ce("sui-empty",o),...s,children:[e?(0,Bn.jsx)("div",{className:"sui-empty-icon","aria-hidden":!0,children:e}):null,t?(0,Bn.jsx)("div",{className:"sui-empty-title",children:t}):null,n?(0,Bn.jsx)("div",{className:"sui-empty-description",children:n}):null,i,a?(0,Bn.jsx)("div",{className:"sui-empty-action",children:a}):null]})}var uh=X(mt(),1);var Se=X(he(),1);function vv(e){return typeof e=="string"?{path:e}:e}function yv(e){let t={name:"",path:"",dirs:[],files:[]};for(let n of e){let a=n.path.split("/").filter(Boolean),o=t;for(let i=0;i<a.length-1;i+=1){let s=a[i],l=o.dirs.find(u=>u.name===s);l||(l={name:s,path:o.path?`${o.path}/${s}`:s,dirs:[],files:[]},o.dirs.push(l)),o=l}o.files.push(n)}return t}function dh(e,t=[]){for(let n of e.dirs)t.push(n.path),dh(n,t);return t}function wv(e){return e.label!==void 0?e.label:e.path.split("/").filter(Boolean).at(-1)??e.path}function ch({dir:e,selected:t,collapsed:n,onToggle:a,onSelect:o,renderAffordance:i}){return(0,Se.jsxs)(Se.Fragment,{children:[e.dirs.map(s=>{let l=n.has(s.path);return(0,Se.jsxs)("div",{className:"sui-file-tree-dir","data-slot":"file-tree-dir",children:[(0,Se.jsxs)("button",{type:"button",className:"sui-file-tree-dir-toggle","data-slot":"file-tree-dir-toggle","aria-expanded":!l,onClick:()=>a(s.path),children:[(0,Se.jsx)("span",{className:"sui-file-tree-caret","aria-hidden":"true"}),(0,Se.jsx)("span",{className:"sui-file-tree-dir-name",children:s.name})]}),l?null:(0,Se.jsx)("div",{className:"sui-file-tree-children",children:(0,Se.jsx)(ch,{dir:s,selected:t,collapsed:n,onToggle:a,onSelect:o,renderAffordance:i})})]},`dir:${s.path}`)}),e.files.map(s=>{let l=s.path===t,u=i?.(s);return(0,Se.jsxs)("div",{className:"sui-file-tree-row","data-slot":"file-tree-row",children:[(0,Se.jsx)("button",{type:"button",className:"sui-file-tree-file","data-slot":"file-tree-file","data-active":l?"true":void 0,title:s.path,onClick:()=>o?.(s.path),children:(0,Se.jsx)("span",{className:"sui-file-tree-file-name",children:wv(s)})}),u!=null&&u!==!1?(0,Se.jsx)("span",{className:"sui-file-tree-affordance","data-slot":"file-tree-affordance",children:u}):null]},`file:${s.path}`)})]})}function yu({nodes:e,selected:t,onSelect:n,renderAffordance:a,defaultCollapsed:o=!1,className:i,...s}){at();let l=e.map(vv),u=yv(l),[c,m]=(0,uh.useState)(()=>o?new Set(dh(u)):new Set),b=f=>{m(h=>{let w=new Set(h);return w.has(f)?w.delete(f):w.add(f),w})};return(0,Se.jsx)("div",{"data-slot":"file-tree",className:Ce("sui-file-tree",i),...s,children:(0,Se.jsx)(ch,{dir:u,selected:t,collapsed:c,onToggle:b,onSelect:n,renderAffordance:a})})}var x={bg:"var(--bg, #FBFBFB)",panel:"var(--surface, #fefefe)",panelAlt:"var(--hover, #f4f3f5)",border:"var(--border-solid, #e6e6e9)",text:"var(--text, #403f53)",textDim:"var(--text-muted, #676676)",accent:"var(--brand, #9449bc)",accentSoft:"var(--brand-soft, color-mix(in srgb, var(--brand, #9449bc) 10%, var(--surface, #fefefe)))",accentBorder:"var(--brand-border, color-mix(in srgb, var(--brand, #9449bc) 40%, transparent))",success:"var(--success, #21766f)",successSoft:"var(--success-soft, color-mix(in srgb, var(--success, #21766f) 12%, var(--surface, #fefefe)))",successBorder:"var(--success-border, color-mix(in srgb, var(--success, #21766f) 40%, transparent))",danger:"var(--danger, #ba3f3c)",dangerSoft:"var(--danger-soft, color-mix(in srgb, var(--danger, #ba3f3c) 10%, var(--surface, #fefefe)))",dangerBorder:"var(--danger-border, color-mix(in srgb, var(--danger, #ba3f3c) 40%, transparent))",warning:"var(--warning, #846701)",warningSoft:"var(--warning-soft, color-mix(in srgb, var(--warning, #846701) 12%, var(--surface, #fefefe)))",warningBorder:"var(--warning-border, color-mix(in srgb, var(--warning, #846701) 40%, transparent))",info:"var(--info, #3f66ba)",infoSoft:"var(--info-soft, color-mix(in srgb, var(--info, #3f66ba) 10%, var(--surface, #fefefe)))",infoBorder:"var(--info-border, color-mix(in srgb, var(--info, #3f66ba) 40%, transparent))",neutralSoft:"var(--hover-subtle, rgba(64,63,83,0.04))",neutralBorder:"var(--border, rgba(64,63,83,0.08))",ring:"var(--ring, color-mix(in srgb, var(--brand, #9449bc) 22%, transparent))",ringBorder:"var(--ring-border, color-mix(in srgb, var(--brand, #9449bc) 50%, transparent))",radius:"var(--r-2, 10px)",fontMono:"var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)",fontSans:"var(--font-sans, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif)"},ph="data-smithers-gateway-ui";var $v=`
.gw-launch-button { cursor:pointer; transition:background-color .12s ease, border-color .12s ease, color .12s ease; }
.gw-launch-button:hover:not(:disabled) { background:color-mix(in srgb, ${x.accent} 85%, ${x.text}); }
.gw-launch-button:active:not(:disabled) { background:color-mix(in srgb, ${x.accent} 72%, ${x.text}); }
.gw-launch-button:disabled { cursor:wait; opacity:.6; }
.gw-launch-button:focus-visible { outline:none; box-shadow:0 0 0 3px ${x.ring}; }
.gw-fleet-row:focus-visible { outline:none; box-shadow:inset 2px 0 0 ${x.accent}, inset 0 0 0 3px ${x.ring}; }
.gw-node-row { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%; padding:6px 8px 6px calc(8px + var(--gw-node-depth, 0) * 16px); border:1px solid transparent; border-left-width:2px; background:transparent; color:${x.text}; cursor:pointer; text-align:left; font-family:${x.fontSans}; font-size:13px; transition:background-color .12s ease, border-color .12s ease, color .12s ease; }
.gw-node-row[data-interactive='false'] { cursor:default; }
.gw-node-row:hover { background:${x.panelAlt}; }
.gw-node-row[data-active='true'] { border-left-color:${x.accent}; background:${x.accentSoft}; }
.gw-run-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 10px; border-radius:${x.radius}; border:1px solid ${x.border}; background:${x.panel}; color:${x.text}; cursor:pointer; text-align:left; transition:background-color .12s ease, border-color .12s ease, color .12s ease; }
.gw-run-row:hover { background:${x.panelAlt}; }
.gw-run-row:active,.gw-node-row:active { background:color-mix(in srgb, ${x.text} 6%, ${x.panelAlt}); }
.gw-run-row[data-active='true'] { border-color:${x.accentBorder}; background:${x.accentSoft}; }
.gw-approval-button { padding:6px 14px; border-radius:6px; border:1px solid var(--gw-tone-border); background:var(--gw-tone-soft); color:var(--gw-tone); font:inherit; font-size:13px; font-weight:650; cursor:pointer; transition:background-color .12s ease, border-color .12s ease, color .12s ease; }
.gw-approval-button:hover:not(:disabled) { background:color-mix(in srgb, var(--gw-tone) 16%, ${x.panel}); }
.gw-approval-button:active:not(:disabled) { background:color-mix(in srgb, var(--gw-tone) 18%, ${x.panel}); }
.gw-approval-button-success { --gw-tone:${x.success}; --gw-tone-soft:${x.successSoft}; --gw-tone-border:${x.successBorder}; }
.gw-approval-button-danger { --gw-tone:${x.danger}; --gw-tone-soft:${x.dangerSoft}; --gw-tone-border:${x.dangerBorder}; }
.gw-approval-button-neutral { --gw-tone:${x.textDim}; --gw-tone-soft:${x.panelAlt}; --gw-tone-border:${x.border}; }
.gw-approval-button:disabled { cursor:not-allowed; opacity:.6; }
.gw-node-row:focus-visible,.gw-run-row:focus-visible,.gw-approval-button:focus-visible { outline:none; border-color:${x.ringBorder}; box-shadow:0 0 0 3px ${x.ring}; }
.gw-status-pill { --gw-tone:${x.textDim}; --gw-tone-soft:${x.neutralSoft}; --gw-tone-border:${x.neutralBorder}; display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border-radius:999px; border:1px solid var(--gw-tone-border); background:var(--gw-tone-soft); color:var(--gw-tone); font-size:12px; font-weight:650; }
.gw-status-pill[data-status-class='run'] { --gw-tone:${x.accent}; --gw-tone-soft:${x.accentSoft}; --gw-tone-border:${x.accentBorder}; }
.gw-status-pill[data-status-class='ok'] { --gw-tone:${x.success}; --gw-tone-soft:${x.successSoft}; --gw-tone-border:${x.successBorder}; }
.gw-status-pill[data-status-class='warn'] { --gw-tone:${x.warning}; --gw-tone-soft:${x.warningSoft}; --gw-tone-border:${x.warningBorder}; }
.gw-status-pill[data-status-class='bad'] { --gw-tone:${x.danger}; --gw-tone-soft:${x.dangerSoft}; --gw-tone-border:${x.dangerBorder}; }
.gw-status-pill-dot { width:6px; height:6px; border-radius:999px; background:var(--gw-tone); }
.gw-node-output-card { --gw-tone:${x.textDim}; --gw-tone-soft:${x.neutralSoft}; }
.gw-node-output-card[data-status='produced'] { --gw-tone:${x.success}; --gw-tone-soft:${x.successSoft}; }
.gw-node-output-card[data-status='failed'] { --gw-tone:${x.danger}; --gw-tone-soft:${x.dangerSoft}; }
.gw-node-output-glyph { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:999px; flex-shrink:0; font-size:12px; font-weight:650; color:var(--gw-tone); background:var(--gw-tone-soft); }
.gw-event-log { display:flex; flex-direction:column; min-width:0; min-height:0; background:${x.bg}; border:1px solid ${x.border}; border-radius:${x.radius}; color:${x.text}; overflow:hidden; }
.gw-event-log-toolbar { display:flex; align-items:center; gap:8px; padding:6px 8px; border-bottom:1px solid ${x.border}; }
.gw-event-log-toolbar-spacer { flex:1; }
.gw-event-log-count { color:${x.textDim}; font-family:${x.fontMono}; font-size:11px; }
.gw-event-rows { display:flex; flex-direction:column; gap:2px; overflow:auto; padding:6px; min-height:0; }
.gw-event-row { display:flex; flex-direction:column; border:1px solid transparent; border-left-width:2px; border-radius:6px; }
.gw-event-row[data-tone='failed'] { border-color:${x.dangerBorder}; background:${x.dangerSoft}; }
.gw-event-row[data-active='true'] { border-left-color:${x.accent}; background:${x.accentSoft}; }
.gw-event-row[data-heartbeat='true'] { opacity:.6; }
.gw-event-row-head { display:flex; align-items:center; gap:2px; width:100%; min-width:0; }
.gw-event-row-main { display:flex; align-items:center; gap:8px; min-width:0; flex:1; padding:4px 6px; background:transparent; border:none; color:${x.text}; font-family:${x.fontSans}; font-size:12px; text-align:left; cursor:default; }
.gw-event-row-main[data-selectable='true'] { cursor:pointer; border-radius:6px; }
.gw-event-row-main[data-selectable='true']:hover { background:${x.panelAlt}; }
.gw-event-row-seq { color:${x.textDim}; font-family:${x.fontMono}; font-size:11px; flex-shrink:0; }
.gw-event-row-chip { font-family:${x.fontMono}; font-size:11px; color:${x.text}; background:${x.neutralSoft}; border:1px solid ${x.neutralBorder}; border-radius:5px; padding:1px 6px; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex-shrink:0; }
.gw-event-row-meta { color:${x.textDim}; font-size:11px; flex-shrink:0; }
.gw-event-row-count { font-family:${x.fontMono}; font-size:11px; color:${x.textDim}; flex-shrink:0; }
.gw-event-row-summary { color:${x.textDim}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1; }
.gw-event-row[data-tone='failed'] .gw-event-row-summary { color:${x.danger}; font-weight:600; }
.gw-event-row-toggle { flex-shrink:0; margin-right:6px; padding:4px 8px; background:transparent; border:1px solid ${x.border}; border-radius:5px; color:${x.textDim}; font-family:${x.fontMono}; font-size:11px; cursor:pointer; }
.gw-event-row-toggle:hover { background:${x.panelAlt}; }
.gw-event-row-json { margin:0 8px 8px 8px; padding:8px; background:${x.panel}; border:1px solid ${x.border}; border-radius:6px; font-family:${x.fontMono}; font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-word; overflow:auto; max-height:280px; color:${x.text}; }
.gw-event-row-main:focus-visible,.gw-event-row-toggle:focus-visible { outline:none; border-color:${x.ringBorder}; box-shadow:0 0 0 3px ${x.ring}; }
.gw-event-log-body { position:relative; display:flex; flex-direction:column; flex:1 1 auto; min-height:0; }
.gw-event-jump { position:absolute; left:50%; bottom:14px; transform:translateX(-50%); z-index:5; display:inline-flex; align-items:center; gap:6px; padding:4px 12px; border:1px solid ${x.border}; border-radius:999px; background:${x.panel}; color:${x.text}; font-family:${x.fontSans}; font-size:12px; cursor:pointer; box-shadow:0 1px 2px rgb(var(--shadow-rgb, 64 63 83) / 0.06), 0 8px 24px rgb(var(--shadow-rgb, 64 63 83) / 0.10); transition:background-color .12s ease, border-color .12s ease, color .12s ease; }
.gw-event-jump:hover { background:${x.panelAlt}; }
.gw-event-jump:focus-visible { outline:none; border-color:${x.ringBorder}; box-shadow:0 0 0 3px ${x.ring}; }
.gw-canvas-node { border-left:3px solid var(--gw-kind, transparent); }
.gw-canvas-node[data-kind='agent'] { --gw-kind:${x.accent}; }
.gw-canvas-node[data-kind='compute'] { --gw-kind:${x.info}; }
.gw-canvas-node[data-kind='approval'] { --gw-kind:${x.warning}; }
.gw-canvas-node[data-kind='merge'] { --gw-kind:${x.success}; }
.gw-canvas-node[data-kind='loop'] { --gw-kind:${x.info}; }
.gw-canvas-node[data-kind='branch'] { --gw-kind:${x.warning}; }
.gw-canvas-node[data-kind='signal'] { --gw-kind:${x.accent}; }
.gw-canvas-node[data-kind='human'] { --gw-kind:${x.danger}; }
.gw-monitor-button { display:inline-flex; align-items:center; gap:6px; text-decoration:none; }
${Bo}
`;function fh(){if(typeof document>"u"||document.querySelector(`style[${ph}]`))return;let e=document.createElement("style");e.setAttribute(ph,""),e.textContent=$v,document.head.appendChild(e)}var gh=X(mt(),1);var Oi=X(he(),1);function wu({status:e,label:t,className:n,style:a}){(0,gh.useInsertionEffect)(fh,[]);let o=mi(e),i=t??bi(e),s={run:{color:x.accent,background:x.accentSoft,borderColor:x.accentBorder},ok:{color:x.success,background:x.successSoft,borderColor:x.successBorder},warn:{color:x.warning,background:x.warningSoft,borderColor:x.warningBorder},bad:{color:x.danger,background:x.dangerSoft,borderColor:x.dangerBorder},muted:{color:x.textDim,background:x.neutralSoft,borderColor:x.neutralBorder}}[o];return(0,Oi.jsxs)("span",{className:["gw-status-pill",n].filter(Boolean).join(" "),"data-status":e,"data-status-class":o,style:{...s,...a},children:[(0,Oi.jsx)("span",{"aria-hidden":!0,className:"gw-status-pill-dot"}),i]})}var Su={"apps/stereos-site/README.md":"# stereos-site\n\nFour-tab page at https://stereos.smithers.sh.\n\n- **Live demo** \u2014 starts real `hello`, `pipeline`, and `approval-demo` runs on\n  the demo host. Each run's sandbox body executes inside a booted stereOS\n  mixtape VM. The page embeds the run UI the host serves and shows the guest\n  facts the run returned. If the host is unreachable the tab says so and points\n  at the recorded runs; it never fabricates a run.\n- **How it works** \u2014 the two recorded runs, as a flow diagram, per-host result\n  cards, a stepped walkthrough whose excerpts are sliced out of the committed\n  captures at render time, and the full unedited captures behind disclosures.\n- **Implementation** \u2014 a file tree over the sources that actually run the demo,\n  with a viewer and per-file GitHub links. Built from `smthrs/ui` `FileTree`,\n  `Card`, `Badge`, `Button`, and `EmptyState` plus `smthrs/gateway-ui`\n  `StatusPill`.\n- **Proposed API** \u2014 the provider design reference, demoted to a secondary tab.\n  Content is lifted verbatim from `tab1-source/stereos-sandbox-provider.html` at\n  build time; edit that file, not the generated page. `build.mjs` scopes the\n  reference stylesheet to `#panel-api` so it cannot reach the rest of the page.\n\nThere is deliberately no `package.json` in this directory, so the app stays out\nof the pnpm workspace and the `check:docs` gates, matching `apps/patterns-site`.\n\nThe design follows `apps/patterns-site`: card grid, tight type scale, inline\nSVG diagrams, near-zero prose. The page holds about 500 words of visible prose.\n\n## Layout\n\n| Path | What it is |\n| --- | --- |\n| `page/index.template.html` | Page shell, design system, tab chrome, and all copy. |\n| `page/flow-diagram.svg` | The host-to-guest flow diagram, inlined into two tabs. |\n| `page/live.js` | Live demo: backend discovery, run control, guest evidence. |\n| `page/evidence.js` | How it works: result cards, walkthrough excerpts, captures. |\n| `page/impl/main.jsx` | Implementation file tree, bundled by esbuild into `site/impl.js`. |\n| `tab1-source/` | Source document for the Proposed API tab. |\n| `real/` | The provider, guest workflow, host scripts, and recorded captures. |\n| `service/` | The demo service that runs on the GCE host. See `service/README.md`. |\n| `project/` | The retired WebContainer demo, kept for reference (PR #1506). |\n| `site/` | Generated deploy output. Do not edit by hand. |\n| `e2e/` | Playwright check against the deployed site. |\n\n## Build and deploy\n\n```sh\nnode apps/stereos-site/build.mjs                     # regenerate site/\ncd apps/stereos-site\n../status-site/node_modules/.bin/wrangler deploy\n```\n\n`build.mjs` reads the implementation sources out of the repository, so the\nImplementation tab cannot drift from the code that runs.\n\n## Test\n\n```sh\npnpm install --frozen-lockfile                       # supplies apps/cli's Playwright dependency\nnode apps/stereos-site/e2e/stereos.e2e.mjs [url]\n```\n\nThe check asserts that the WebContainer simulation tab and its assets are gone,\nthat the Live demo tab starts a real run that reaches the engine-reported\n`finished` state and reports `coder-dev` guest facts, that `approval-demo` parks\nat its gate and finishes after the Approve click inside the embedded UI, that\nthe guard does not expose gateway RPC, that the file tree opens `service/guard.ts`\nand shows source byte-identical to the repository, and that both recorded\ncaptures and the Proposed API document still hold their claims. Budget 3-6\nminutes; a cold VM boot on the demo host adds about 30 seconds.\n","apps/stereos-site/build.mjs":`// Build the deployable site assets.
//
// 1. Assembles site/index.html from page/index.template.html, scoping the tab-4
//    reference document's stylesheet to #panel-api and lifting its <main>
//    verbatim.
// 2. Copies the page scripts to site/.
// 3. Serializes the real/ evidence (recorded transcripts plus provider sources)
//    into site/real-run.js.
// 4. Serializes the implementation sources into site/impl-files.js and bundles
//    the Implementation file tree, a React app built on the shipped
//    smthrs/ui components, into site/impl.js.
//
// Run: node apps/stereos-site/build.mjs
import { copyFile, readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const siteDir = join(here, "site");
const require = createRequire(import.meta.url);

await mkdir(siteDir, { recursive: true });

// \u2500\u2500 1. The reference document \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// The reference ships a complete page stylesheet (\`body\`, \`h1\`, \`table\`, ...).
// The rest of this page has its own design system, so every reference rule is
// rewritten to apply only inside #panel-api. \`:root\` and \`body\` rules become
// \`#panel-api\` rules so the document keeps its own tokens and type without
// reaching the shell.
const SCOPE = "#panel-api";

/** Prefix one comma-separated selector list with the panel scope. */
function scopeSelector(selectorList) {
  return selectorList
    .split(",")
    .map((selector) => {
      const trimmed = selector.trim();
      if (!trimmed) return trimmed;
      // Tokens that describe the document itself become the panel.
      if (trimmed === ":root" || trimmed === "html" || trimmed === "body") return SCOPE;
      if (trimmed === "*") return \`\${SCOPE}, \${SCOPE} *\`;
      return \`\${SCOPE} \${trimmed}\`;
    })
    .filter(Boolean)
    .join(", ");
}

/**
 * Rewrite a stylesheet so every rule is scoped to {@link SCOPE}.
 * Handles nested at-rules (\`@media\`) by scoping their inner rules instead.
 */
function scopeCss(css) {
  let out = "";
  let index = 0;
  while (index < css.length) {
    const brace = css.indexOf("{", index);
    if (brace === -1) {
      out += css.slice(index);
      break;
    }
    const prelude = css.slice(index, brace).trim();
    // Find the matching close brace for this block.
    let depth = 0;
    let end = brace;
    for (; end < css.length; end += 1) {
      if (css[end] === "{") depth += 1;
      else if (css[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = css.slice(brace + 1, end);
    if (prelude.startsWith("@")) {
      // Conditional group rules wrap more rules; scope those.
      out += \`\${prelude} {\${/^@(media|supports|layer|container)/.test(prelude) ? scopeCss(body) : body}}\\n\`;
    } else {
      out += \`\${scopeSelector(prelude)} {\${body}}\\n\`;
    }
    index = end + 1;
  }
  return out;
}

const reference = await readFile(join(here, "tab1-source/stereos-sandbox-provider.html"), "utf8");
const styleMatch = reference.match(/<style>([\\s\\S]*?)<\\/style>/);
const mainMatch = reference.match(/<main>[\\s\\S]*?<\\/main>/);
if (!styleMatch || !mainMatch) {
  throw new Error("reference document is missing its <style> or <main>");
}

const flowDiagram = (await readFile(join(here, "page/flow-diagram.svg"), "utf8")).trim();

for (const script of ["live.js", "evidence.js"]) {
  await copyFile(join(here, "page", script), join(siteDir, script));
}

// The removed WebContainer tab needed cross-origin isolation for
// SharedArrayBuffer, which COEP: require-corp provided. Nothing on the page
// needs it now, and require-corp would block the cross-origin demo iframe, so
// only the framing and sniffing protections remain.
await writeFile(
  join(siteDir, "_headers"),
  \`/*\\n  X-Content-Type-Options: nosniff\\n  Referrer-Policy: strict-origin-when-cross-origin\\n  X-Frame-Options: SAMEORIGIN\\n\`,
);

// \u2500\u2500 2. Recorded evidence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const realDir = join(here, "real");
const realFile = (name) => readFile(join(realDir, name), "utf8");
const realRun = {
  hosts: [
    {
      key: "linux",
      label: "GCE nested virt \xB7 KVM \xB7 x86_64 mixtape",
      transcript: await realFile("transcript-linux.txt"),
      kpis: {
        Host: "GCE n2-standard-2, nested virt",
        Hypervisor: "QEMU/KVM",
        Mixtape: "coder-dev x86_64, built from source",
        "Guest kernel": "Linux 6.18.33 x86_64",
        "Run id": "55c1ccb5-9ddf-4912-82eb-eb35efd69767",
        "Sandbox duration": "1,939 ms",
        "Guest reported": "agent@coder-dev, Bun 1.2.21 x64",
      },
    },
    {
      key: "macos",
      label: "Apple hypervisor \xB7 aarch64 mixtape",
      transcript: await realFile("transcript.txt"),
      kpis: {
        Host: "Apple Silicon Mac",
        Hypervisor: "Apple Virtualization.framework via mb",
        Mixtape: "coder-arm64:latest, fetched by hand",
        "Guest kernel": "Linux 6.12.74 aarch64",
        "Sandbox duration": "768 ms",
        "Guest reported": "agent@coder, Bun 1.2.21 arm64",
      },
    },
  ],
};
await writeFile(
  join(siteDir, "real-run.js"),
  \`// Generated by apps/stereos-site/build.mjs from real/. Do not edit.\\nexport const realRun = \${JSON.stringify(realRun, null, 2)};\\n\`,
);

// \u2500\u2500 3. Implementation sources \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// Every file the Implementation tab lists is read from the repository here, so
// the tab cannot drift from the code that actually runs.
const IMPL_ROOTS = [
  { dir: "apps/stereos-site/service", label: "service" },
  { dir: "apps/stereos-site/real", label: "real" },
  { dir: "apps/stereos-site/page", label: "page" },
];
const IMPL_SINGLES = ["apps/stereos-site/build.mjs", "apps/stereos-site/README.md", "apps/stereos-site/e2e/stereos.e2e.mjs"];
const SKIP = new Set(["node_modules", "dist", ".smithers"]);
const TEXT = /\\.(ts|tsx|js|jsx|mjs|sh|md|toml|json|html|css|svg|service)$/;

/** Collect every text source under a directory, relative to the repository root. */
async function collect(dir, out = []) {
  for (const entry of await readdir(join(repoRoot, dir), { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
    const rel = \`\${dir}/\${entry.name}\`;
    if (entry.isDirectory()) await collect(rel, out);
    else if (TEXT.test(entry.name)) out.push(rel);
  }
  return out;
}

const implPaths = [];
for (const root of IMPL_ROOTS) implPaths.push(...(await collect(root.dir)));
implPaths.push(...IMPL_SINGLES);

const implFiles = {};
for (const path of implPaths.sort()) {
  // Transcripts are evidence, not implementation, and are already on the
  // How it works tab. The generated bundle input is this listing itself.
  if (path.includes("transcript") || path.endsWith(".generated.js")) continue;
  implFiles[path] = await readFile(join(repoRoot, path), "utf8");
}
// Written beside the bundle entry rather than into site/: it is the bundler's
// input, not a deployed asset, and shipping it would double the payload.
await writeFile(
  join(here, "page/impl/impl-files.generated.js"),
  \`// Generated by apps/stereos-site/build.mjs from the repository. Do not edit.\\nexport const implFiles = \${JSON.stringify(implFiles, null, 2)};\\n\`,
);

// \u2500\u2500 4. The Implementation file tree bundle \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//
// A small React app composed from shipped smthrs/ui components. esbuild is
// already a dependency of this repository and produces a self-hosted bundle;
// nothing is fetched from a CDN.
const esbuild = require("esbuild");
await esbuild.build({
  entryPoints: [join(here, "page/impl/main.jsx")],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  outfile: join(siteDir, "impl.js"),
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".css": "text" },
  logLevel: "warning",
});

// site/ used to hold the WebContainer bundle and its project tree. Both belong
// to the removed simulation tab.
for (const stale of ["webcontainer-api.js", "project-files.js", "demo.js", "real.js"]) {
  await rm(join(siteDir, stale), { force: true });
}

// The cache key is a digest of everything index.html loads, so any rebuild that
// changes a script also changes its URL. A date stamp would not: two builds on
// the same day would share a URL and the CDN would keep serving the first.
const assets = await Promise.all(
  ["live.js", "evidence.js", "impl.js", "real-run.js"].map((name) => readFile(join(siteDir, name), "utf8")),
);
const stamp = createHash("sha256").update(assets.join("\\u0000")).digest("hex").slice(0, 12);

const template = await readFile(join(here, "page/index.template.html"), "utf8");
await writeFile(
  join(siteDir, "index.html"),
  template
    .replace("__REFERENCE_STYLE__", scopeCss(styleMatch[1].trim()).trim())
    .replace("__REFERENCE_MAIN__", mainMatch[0])
    .replaceAll("__FLOW_DIAGRAM__", flowDiagram)
    .replaceAll("__BUILD__", stamp),
);

console.log(
  \`index.html (v=\${stamp}) + live.js + evidence.js + impl.js; impl-files.js: \${Object.keys(implFiles).length} files; real-run.js: \${realRun.hosts.length} hosts\`,
);
`,"apps/stereos-site/e2e/stereos.e2e.mjs":`// End-to-end check against the deployed site.
//
// Asserts that the WebContainer simulation tab is gone, that the Live demo tab
// starts a REAL run on a real stereOS VM and carries it to the engine-reported
// \`finished\` state (including the approval click inside the embedded UI), that
// the Implementation file tree opens a file and shows its real source, and that
// the recorded-evidence and Proposed API tabs still hold their claims.
//
// Timeouts allow for a cold VM boot on the demo host.
//
// Run: node apps/stereos-site/e2e/stereos.e2e.mjs [url]
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// apps/cli declares Playwright. Resolve through that package so this works in
// any checkout and with any pnpm virtual-store layout.
const require = createRequire(new URL("../../cli/package.json", import.meta.url));
const { chromium } = require("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const url = process.argv[2] ?? "https://stereos.smithers.sh/";
const logPath = join(here, "last-run.log");
const failures = [];

writeFileSync(logPath, \`\${url}\\n\`);

/** Write a line to stdout and to the log file, so a killed run still leaves evidence. */
function say(line) {
  console.log(line);
  appendFileSync(logPath, \`\${line}\\n\`);
}

/** Record a check result. */
function check(name, ok, detail = "") {
  say(\`\${ok ? "PASS" : "FAIL"}  \${name}\${detail ? \` \u2014 \${detail}\` : ""}\`);
  if (!ok) failures.push(name);
}

/** Poll until predicate returns truthy or the deadline passes. */
async function waitFor(label, predicate, timeoutMs, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  say(\`timeout waiting for \${label}\`);
  return null;
}

await mkdir(here, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on("pageerror", (error) => say(\`pageerror: \${error.message.slice(0, 200)}\`));

const response = await page.goto(url, { waitUntil: "load" });

// \u2500\u2500 1. Page identity and the removed simulation tab \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
check(
  "inline favicon",
  (await page.locator('link[rel="icon"]').getAttribute("href"))?.startsWith("data:image/svg+xml") === true,
);
check(
  "meta description",
  ((await page.locator('meta[name="description"]').getAttribute("content")) ?? "").includes("real Smithers Sandbox"),
);
// site/_headers is applied by the Cloudflare deployment, not by a local
// static server, so this only asserts against a deployed origin.
if (url.startsWith("https://")) {
  check("security headers applied", response.headers()["x-content-type-options"] === "nosniff");
} else {
  say("SKIP  security headers \u2014 local static server does not apply site/_headers");
}

check("Live demo is the default tab", (await page.locator("#tab-live").getAttribute("aria-selected")) === "true");
const tabNames = await page.locator('[role="tab"]').allTextContents();
check("four named tabs", tabNames.join(" | ") === "Live demo | How it works | Implementation | Proposed API", tabNames.join(" | "));

// The WebContainer simulation tab and everything that drove it must be gone.
check("simulation tab removed", (await page.locator("#tab-demo").count()) === 0);
check("simulation panel removed", (await page.locator("#panel-demo").count()) === 0);
const bodyText = (await page.locator("body").textContent()) ?? "";
check("no simulation copy remains", !bodyText.includes("simulates the seam") && !bodyText.includes("simulated VM"));
// The removed work is named once, in the footer pointer, and nowhere else.
const footerText = (await page.locator("footer.bottom").textContent()) ?? "";
check(
  "WebContainer is mentioned only in the footer pointer",
  bodyText.split("WebContainer").length - 1 === footerText.split("WebContainer").length - 1,
);
for (const stale of ["demo.js", "webcontainer-api.js", "project-files.js"]) {
  const stalePresent = await page.evaluate(
    async (name) => (await fetch(new URL(name, location.href)).catch(() => ({ ok: false }))).ok,
    stale,
  );
  check(\`stale asset \${stale} is gone\`, stalePresent === false);
}
// The removed work is preserved with a pointer, not deleted silently.
check(
  "footer preserves the WebContainer work",
  bodyText.includes("plain Node") && (await page.locator('a[href*="/pull/1506"]').count()) > 0,
);

// \u2500\u2500 2. Live demo: a real run on a real stereOS VM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const reachable = await waitFor(
  "demo host",
  async () => {
    const status = await page.locator("#live-status").textContent();
    if (status === "ready") return "ready";
    if (status === "demo host unreachable") return "offline";
    return null;
  },
  60_000,
  1000,
);

if (reachable === "offline") {
  // The tab must degrade honestly rather than fake a run.
  check("offline banner is shown", await page.locator("#offline-banner").isVisible());
  check("start buttons are disabled when offline", await page.locator("#run-hello").isDisabled());
  failures.push("demo host unreachable (live-run checks skipped)");
  say("demo host unreachable: the live-run checks did not execute");
} else {
  check("demo host reachable", reachable === "ready");
  check("offline banner is hidden", (await page.locator("#offline-banner").getAttribute("hidden")) !== null);

  const frame = page.frameLocator("#demo-frame");
  check("embedded run UI mounts", (await waitFor("app", async () => ((await frame.locator('[data-testid="stereos-demo-app"]').count()) > 0 ? true : null), 60_000)) === true);

  // hello: start from the page, finish on a real VM.
  await page.click("#run-hello");
  const helloDone = await waitFor(
    "hello finish",
    async () => {
      const status = await page.locator("#live-status").textContent();
      return status === "finished" ? status : status === "failed" ? "failed" : null;
    },
    6 * 60 * 1000,
  );
  check("hello reaches engine-reported finished", helloDone === "finished", String(helloDone));

  const guestHost = await page.locator("#kpi-host").textContent();
  const guestKernel = await page.locator("#kpi-kernel").textContent();
  const guestRestrict = await page.locator("#kpi-restrict").textContent();
  check("run reports the guest hostname", guestHost === "coder-dev", String(guestHost));
  check("guest kernel differs from the Debian host", /^Linux 6\\.\\d+/.test(guestKernel ?? ""), String(guestKernel));
  check("guest restriction model holds", guestRestrict === "denied", String(guestRestrict));
  await page.screenshot({ path: join(here, "tab1-live-demo.png"), fullPage: false });

  // approval-demo: park at the gate, click Approve inside the embedded UI.
  await page.click("#run-approval");
  const parked = await waitFor(
    "approval gate",
    async () => {
      const status = (await page.locator("#live-status").textContent()) ?? "";
      // "starting approval-demo" also contains the word, so match the parked copy.
      return status.startsWith("waiting for your approval") ? status : null;
    },
    6 * 60 * 1000,
  );
  check("approval-demo parks at the gate", Boolean(parked), String(parked));

  const approve = frame.locator('[data-testid="approve"]');
  const approveReady = await waitFor("approve button", async () => ((await approve.count()) > 0 ? true : null), 3 * 60 * 1000);
  check("embedded UI offers the approval", Boolean(approveReady));
  await page.screenshot({ path: join(here, "tab1-live-approval.png"), fullPage: false });

  if (approveReady) {
    await approve.click();
    const approvedDone = await waitFor(
      "approval-demo finish",
      async () => {
        const status = await page.locator("#live-status").textContent();
        return status === "finished" ? status : status === "failed" ? "failed" : null;
      },
      6 * 60 * 1000,
    );
    check("approval-demo finishes after the click", approvedDone === "finished", String(approvedDone));
    const finishedInFrame = await waitFor(
      "engine-finished run in the frame",
      async () => ((await frame.locator('[data-run-status="finished"]').count()) > 0 ? true : null),
      2 * 60 * 1000,
    );
    check("embedded UI shows an engine-finished run", Boolean(finishedInFrame));
  }
  await page.screenshot({ path: join(here, "tab1-live-demo-final.png"), fullPage: false });

  // The guard must not expose the gateway RPC surface.
  const base = await page.evaluate(() => document.getElementById("demo-frame")?.src ?? "");
  if (base) {
    const leak = await page.evaluate(async (origin) => {
      const results = {};
      for (const path of ["/v1/rpc/listWorkflows", "/api/runs/../../etc/passwd", "/v1/rpc/hijackRun"]) {
        try {
          const response = await fetch(new URL(path, origin), { method: "POST", body: "{}" });
          results[path] = response.status;
        } catch {
          results[path] = "blocked";
        }
      }
      return results;
    }, base);
    check(
      "gateway RPC is not reachable through the guard",
      Object.values(leak).every((status) => status === 404 || status === "blocked"),
      JSON.stringify(leak),
    );
  }
}

// \u2500\u2500 3. How it works: the recorded evidence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
await page.click("#tab-real");
const realText = (await page.locator("#panel-real").textContent()) ?? "";
check("evidence tab headline", realText.includes("Two hosts, one provider"));
check(
  "registry defect is documented",
  realText.includes("d335283a5c0c9fde") && realText.includes("bf212e026f722ccc") && realText.includes("Data corruption detected"),
);

const walkthroughSteps = await page.locator("#walkthrough li").count();
check("stepped walkthrough is present", walkthroughSteps >= 5, \`\${walkthroughSteps} steps\`);
const stepText = (await page.locator("#walkthrough").textContent()) ?? "";
check("walkthrough excerpts come from the capture", stepText.includes("SandboxCreated") && stepText.includes("coder-dev"));
check("no excerpt marker went missing", !stepText.includes("marker not present"));

const captures = await page.locator("details.raw").count();
check("both full captures are collapsed by default", captures === 2, \`\${captures} captures\`);
check("captures start closed", (await page.locator("details.raw[open]").count()) === 0);

await page.locator("details.raw").first().click();
const linuxCapture = (await page.locator("#capture-linux").textContent()) ?? "";
check(
  "x86_64 capture proves guest execution",
  linuxCapture.includes("agent@coder-dev on Linux 6.18.33 x86_64") &&
    linuxCapture.includes("Bun 1.2.21 x64") &&
    linuxCapture.includes("SandboxCompleted") &&
    linuxCapture.includes('"writeOutsideWorkspace": "denied"'),
  \`\${linuxCapture.length} chars\`,
);
const macCapture = (await page.locator("#capture-macos").textContent()) ?? "";
check(
  "aarch64 capture is the second host",
  macCapture.includes("Linux 6.12.74 aarch64") && macCapture.includes("Bun 1.2.21 arm64"),
  \`\${macCapture.length} chars\`,
);
await page.screenshot({ path: join(here, "tab2-how-it-works.png"), fullPage: false });

// \u2500\u2500 4. Implementation file tree \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
await page.click("#tab-impl");
check("file tree renders", (await waitFor("tree", async () => ((await page.locator('[data-testid="impl-tree"]').count()) > 0 ? true : null), 30_000)) === true);
const treeFiles = await page.locator('[data-slot="file-tree-file"]').count();
check("tree lists the implementation sources", treeFiles >= 20, \`\${treeFiles} files\`);

// Open a specific file and compare it against the repository.
const guardEntry = page.locator('[data-slot="file-tree-file"][title="service/guard.ts"]');
check("tree contains the guard source", (await guardEntry.count()) > 0);
await guardEntry.click();
await page.waitForTimeout(400);
check("viewer shows the opened path", (await page.locator('[data-testid="impl-path"]').textContent()) === "apps/stereos-site/service/guard.ts");
const shown = (await page.locator('[data-testid="impl-source"]').textContent()) ?? "";
const onDisk = readFileSync(join(repoRoot, "apps/stereos-site/service/guard.ts"), "utf8");
check("viewer source matches the repository", shown.trim() === onDisk.trim(), \`\${shown.length} vs \${onDisk.length} chars\`);
check("source is syntax highlighted", (await page.locator('[data-testid="impl-source"] span[style*="color"]').count()) > 5);
const githubHref = await page.locator('[data-testid="impl-github"]').getAttribute("href");
check(
  "per-file GitHub link",
  githubHref === "https://github.com/smithersai/smithers/blob/main/apps/stereos-site/service/guard.ts",
  String(githubHref),
);
await page.screenshot({ path: join(here, "tab3-implementation.png"), fullPage: false });

// \u2500\u2500 5. Proposed API stays a reference \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
await page.click("#tab-api");
const apiTitle = await page.locator("#panel-api h1").first().textContent();
const shikiBlocks = await page.locator("#panel-api pre.shiki").count();
check("Proposed API h1", apiTitle?.includes("stereOS Sandbox Provider"), apiTitle ?? "");
check("Proposed API keeps its highlighted code", shikiBlocks > 0, \`\${shikiBlocks} blocks\`);
await page.screenshot({ path: join(here, "tab4-proposed-api.png"), fullPage: false });

await browser.close();

say(\`\\n\${failures.length === 0 ? "ALL CHECKS PASSED" : \`FAILED: \${failures.join(", ")}\`}\`);
process.exit(failures.length === 0 ? 0 : 1);
`,"apps/stereos-site/page/evidence.js":`// How it works tab: the recorded runs, rendered from the committed captures.
//
// Every excerpt below is sliced out of real/transcript-linux.txt at render
// time by matching on text that is present in the committed file. Nothing here
// is retyped, so an edited capture changes the page and a missing marker shows
// as a visible gap rather than stale prose.
import { realRun } from "./real-run.js";

const linux = realRun.hosts.find((host) => host.key === "linux");

/**
 * Take \`lines\` lines of the capture starting at the first line containing
 * \`marker\`. Returns a short notice rather than throwing if the marker moved.
 */
function excerpt(transcript, marker, lines) {
  const all = transcript.split("\\n");
  const start = all.findIndex((line) => line.includes(marker));
  if (start === -1) return \`(marker not present in the capture: \${marker})\`;
  return all
    .slice(start, start + lines)
    .join("\\n")
    .trimEnd();
}

// One sentence per step, each tied to a stage of the flow diagram above.
const STEPS = [
  ["The host boots the mixtape under QEMU/KVM and waits for the guest's sshd.", "== install official Bun", 2],
  ["The guest has no JavaScript runtime, so the host copies the pinned Bun musl build in.", "1.2.21", 1],
  ["The guest identifies itself: a different kernel, hostname, and distribution from the host.", "== guest ==", 5],
  ["Smithers starts the run on the host and schedules the one Sandbox node.", "[00:00:00] \u2192 stereos-vm", 1],
  ["The provider opens the sandbox, uploads the runner and the bundled child workflow, and Bun executes it in the guest.", "SandboxCreated", 1],
  ["The engine records the sandbox lifecycle and its duration.", "SandboxCompleted", 1],
  ["The guest's own result comes back as JSON, reporting facts only the guest can know.", '"summary"', 6],
];

const walkthrough = document.getElementById("walkthrough");
if (walkthrough && linux) {
  walkthrough.innerHTML = "";
  for (const [sentence, marker, lines] of STEPS) {
    const item = document.createElement("li");
    const body = document.createElement("div");
    const heading = document.createElement("h3");
    heading.textContent = sentence;
    const pre = document.createElement("pre");
    pre.textContent = excerpt(linux.transcript, marker, lines);
    body.append(heading, pre);
    item.append(body);
    walkthrough.append(item);
  }
}

// Result cards: one per host, values from the build-time manifest.
const hostCards = document.getElementById("host-cards");
if (hostCards) {
  hostCards.innerHTML = "";
  for (const host of realRun.hosts) {
    const card = document.createElement("div");
    card.className = "card";
    const body = document.createElement("div");
    body.className = "card-body";
    const kind = document.createElement("span");
    kind.className = \`kind \${host.key === "linux" ? "guest" : "host"}\`;
    kind.textContent = host.key === "linux" ? "x86_64 \xB7 KVM" : "aarch64 \xB7 Apple";
    const title = document.createElement("h3");
    title.textContent = host.label;
    const list = document.createElement("dl");
    list.className = "kpis";
    list.style.marginTop = "10px";
    for (const [label, value] of Object.entries(host.kpis)) {
      const tile = document.createElement("div");
      tile.className = "kpi";
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      tile.append(dt, dd);
      list.append(tile);
    }
    body.append(kind, title, list);
    card.append(body);
    hostCards.append(card);
  }
}

// Full captures, collapsed. The e2e reads these, so they stay in the DOM.
const raw = document.getElementById("raw-captures");
if (raw) {
  raw.innerHTML = "";
  for (const host of realRun.hosts) {
    const details = document.createElement("details");
    details.className = "raw";
    const summary = document.createElement("summary");
    summary.textContent = \`Full capture (unedited) \xB7 \${host.label}\`;
    const pre = document.createElement("pre");
    pre.id = \`capture-\${host.key}\`;
    pre.tabIndex = 0;
    pre.textContent = host.transcript;
    details.append(summary, pre);
    raw.append(details);
  }
}
`,"apps/stereos-site/page/flow-diagram.svg":`<svg viewBox="0 0 1080 210" role="img" aria-label="Flow: the Smithers engine on the host drives a Sandbox provider over SSH into a stereOS VM, where Bun runs the child workflow and returns result JSON to the host.">
  <defs>
    <marker id="fd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" />
    </marker>
  </defs>
  <g font-family="Inter, ui-sans-serif, system-ui, sans-serif" color="var(--muted)">

    <!-- Host side -->
    <rect x="4" y="30" width="392" height="104" rx="14" fill="none" stroke="var(--blue)" stroke-width="1" stroke-dasharray="4 4" opacity=".7" />
    <text x="18" y="22" font-size="11" font-weight="800" letter-spacing=".08em" fill="var(--blue)">HOST \xB7 DEBIAN ON GCE</text>

    <rect x="22" y="52" width="164" height="60" rx="11" fill="var(--card)" stroke="var(--line)" />
    <text x="104" y="78" font-size="13" font-weight="600" text-anchor="middle" fill="var(--ink)">Smithers engine</text>
    <text x="104" y="96" font-size="11" text-anchor="middle" fill="var(--muted)">scheduler, event log</text>

    <rect x="214" y="52" width="164" height="60" rx="11" fill="var(--card)" stroke="var(--line)" />
    <text x="296" y="78" font-size="13" font-weight="600" text-anchor="middle" fill="var(--ink)">&#60;Sandbox&#62; provider</text>
    <text x="296" y="96" font-size="11" text-anchor="middle" fill="var(--muted)">createCommandSandboxProvider</text>

    <path d="M186 82 H210" stroke="var(--muted)" stroke-width="1.5" fill="none" marker-end="url(#fd-arrow)" />

    <!-- SSH hop -->
    <path d="M378 82 H452" stroke="var(--orange)" stroke-width="1.8" fill="none" marker-end="url(#fd-arrow)" />
    <text x="415" y="72" font-size="11" font-weight="700" text-anchor="middle" fill="var(--orange)">SSH</text>

    <!-- Guest side -->
    <rect x="456" y="30" width="620" height="104" rx="14" fill="none" stroke="var(--green)" stroke-width="1" stroke-dasharray="4 4" opacity=".7" />
    <text x="470" y="22" font-size="11" font-weight="800" letter-spacing=".08em" fill="var(--green)">GUEST \xB7 stereOS MIXTAPE VM \xB7 QEMU/KVM</text>

    <rect x="474" y="52" width="180" height="60" rx="11" fill="var(--card)" stroke="var(--line)" />
    <text x="564" y="78" font-size="13" font-weight="600" text-anchor="middle" fill="var(--ink)">guest-runner.sh</text>
    <text x="564" y="96" font-size="11" text-anchor="middle" fill="var(--muted)">checks paths, execs Bun</text>

    <path d="M654 82 H682" stroke="var(--muted)" stroke-width="1.5" fill="none" marker-end="url(#fd-arrow)" />

    <rect x="686" y="52" width="188" height="60" rx="11" fill="var(--card)" stroke="var(--line)" />
    <text x="780" y="78" font-size="13" font-weight="600" text-anchor="middle" fill="var(--ink)">Bun 1.2.21</text>
    <text x="780" y="96" font-size="11" text-anchor="middle" fill="var(--muted)">runs child-workflow.js</text>

    <path d="M874 82 H902" stroke="var(--muted)" stroke-width="1.5" fill="none" marker-end="url(#fd-arrow)" />

    <rect x="906" y="52" width="152" height="60" rx="11" fill="var(--green-soft)" stroke="var(--green)" />
    <text x="982" y="78" font-size="13" font-weight="600" text-anchor="middle" fill="var(--ink)">guest facts</text>
    <text x="982" y="96" font-size="11" text-anchor="middle" fill="var(--muted)">+ computed result</text>

    <!-- Return path -->
    <path d="M982 118 V166 H104 V116" stroke="var(--muted)" stroke-width="1.5" fill="none" stroke-dasharray="5 4" marker-end="url(#fd-arrow)" />
    <text x="543" y="182" font-size="11" font-weight="700" text-anchor="middle" fill="var(--muted)">result JSON, written to SMITHERS_SANDBOX_RESULT_PATH</text>
  </g>
</svg>
`,"apps/stereos-site/page/impl/main.jsx":`/**
 * The Implementation tab: a file tree over the sources that actually run this
 * demo, with a viewer and per-file GitHub links.
 *
 * Composed from shipped components. \`FileTree\`, \`Card\`, \`EmptyState\`,
 * \`Badge\`, and \`Button\` come from \`smthrs/ui\` unchanged; \`StatusPill\` comes
 * from \`smthrs/gateway-ui\`. Nothing here reimplements a smithers component.
 *
 * The one thing \`smthrs/ui\` does not ship is a syntax highlighter, so the
 * viewer applies a small tokenizer of its own. It is presentation over the
 * exact bytes read from the repository at build time; the text itself is
 * unmodified.
 */
import { createRoot } from "react-dom/client";
import { useMemo, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, FileTree } from "smthrs/ui";
import { StatusPill } from "smthrs/gateway-ui";
// Generated by build.mjs immediately before this bundle is produced.
import { implFiles } from "./impl-files.generated.js";

const GITHUB = "https://github.com/smithersai/smithers/blob/main";
// Every file lives under one directory, so the tree shows paths relative to it
// and keeps the repository path for the GitHub link.
const PREFIX = "apps/stereos-site/";
const paths = Object.keys(implFiles).sort();
const shortOf = (path) => (path.startsWith(PREFIX) ? path.slice(PREFIX.length) : path);
const fullOf = (short) => paths.find((path) => shortOf(path) === short) ?? short;
const treeNodes = paths.map(shortOf);

/** What each top-level area of the tree is for, shown above the viewer. */
const AREAS = [
  [/^apps\\/stereos-site\\/service\\//, "Demo service", "The gateway workspace, the guard, and the systemd units behind the Live demo tab."],
  [/^apps\\/stereos-site\\/real\\//, "Recorded runs", "The provider, guest workflow, and host scripts that produced the captures."],
  [/^apps\\/stereos-site\\/page\\//, "This page", "The page shell and the scripts behind each tab."],
  [/^apps\\/stereos-site\\//, "Build and checks", "The site build and the end-to-end check that runs against production."],
];

const areaOf = (path) => AREAS.find(([pattern]) => pattern.test(path)) ?? [null, "Source", ""];

const LANGUAGE = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript",
  sh: "shell", md: "markdown", toml: "toml", json: "json", html: "html", css: "css",
  svg: "svg", service: "systemd",
};
const languageOf = (path) => LANGUAGE[path.split(".").pop() ?? ""] ?? "text";

const KEYWORDS = new RegExp(
  \`\\\\b(\${[
    "import", "export", "from", "const", "let", "var", "function", "return", "async", "await",
    "if", "else", "for", "while", "try", "catch", "finally", "throw", "new", "class", "extends",
    "type", "interface", "default", "as", "of", "in", "typeof", "instanceof", "void", "null",
    "undefined", "true", "false", "this", "set", "exec", "echo", "then", "fi", "do", "done",
    "local", "sudo", "systemctl",
  ].join("|")})\\\\b\`,
  "g",
);

/**
 * Split source into styled spans. Comments and strings win over keywords, so
 * the pass runs longest-match-first over one combined pattern.
 */
function highlight(source, language) {
  if (language === "markdown" || language === "text") return [{ text: source }];
  const pattern =
    /(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*|#[^\\n]*|"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)/g;
  const out = [];
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) out.push(...keywords(source.slice(last, match.index)));
    const value = match[0];
    const kind = value.startsWith("//") || value.startsWith("/*") || value.startsWith("#") ? "comment" : "string";
    out.push({ text: value, kind });
    last = match.index + value.length;
  }
  if (last < source.length) out.push(...keywords(source.slice(last)));
  return out;
}

function keywords(chunk) {
  const out = [];
  let last = 0;
  for (const match of chunk.matchAll(KEYWORDS)) {
    if (match.index > last) out.push({ text: chunk.slice(last, match.index) });
    out.push({ text: match[0], kind: "keyword" });
    last = match.index + match[0].length;
  }
  if (last < chunk.length) out.push({ text: chunk.slice(last) });
  return out;
}

const TONE = {
  comment: "var(--muted)",
  string: "var(--green)",
  keyword: "var(--purple)",
};

function App() {
  const [selected, setSelected] = useState("apps/stereos-site/service/guard.ts");
  const source = implFiles[selected] ?? "";
  const language = languageOf(selected);
  const spans = useMemo(() => highlight(source, language), [source, language]);
  const [, areaTitle, areaNote] = areaOf(selected);
  const lines = source ? source.split("\\n").length : 0;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 300px) minmax(0, 1fr)", gap: 14, alignItems: "start" }}>
      <Card data-testid="impl-tree">
        <CardHeader>
          <CardTitle style={{ fontSize: 13 }}>
            {paths.length} files <Badge variant="muted">read at build time</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent style={{ maxHeight: 620, overflow: "auto" }}>
          <FileTree
            nodes={treeNodes}
            selected={shortOf(selected)}
            onSelect={(short) => setSelected(fullOf(short))}
          />
        </CardContent>
      </Card>

      {source ? (
        <Card data-testid="impl-viewer" data-path={selected}>
          <CardHeader>
            <CardTitle style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 13 }}>
              <code data-testid="impl-path" style={{ fontSize: 12 }}>
                {selected}
              </code>
              <StatusPill status="ok" label={language} />
              <Badge variant="muted">{lines} lines</Badge>
              <Button asChild size="sm" variant="outline" style={{ marginLeft: "auto" }}>
                <a href={\`\${GITHUB}/\${selected}\`} target="_blank" rel="noreferrer" data-testid="impl-github">
                  View on GitHub
                </a>
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p style={{ margin: "0 0 10px", color: "var(--muted)", fontSize: 12, lineHeight: 1.5 }}>
              <strong style={{ color: "var(--ink)" }}>{areaTitle}.</strong> {areaNote}
            </p>
            <pre
              data-testid="impl-source"
              style={{
                margin: 0,
                maxHeight: 560,
                overflow: "auto",
                padding: "12px 14px",
                // Card content is muted by default; source must stay full contrast.
                color: "var(--ink)",
                background: "var(--diagram)",
                border: "1px solid var(--line)",
                borderRadius: 10,
                font: "11.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace",
                whiteSpace: "pre",
              }}
            >
              {spans.map((span, index) => (
                // eslint-disable-next-line react/no-array-index-key -- spans are positional
                <span key={index} style={span.kind ? { color: TONE[span.kind] } : undefined}>
                  {span.text}
                </span>
              ))}
            </pre>
          </CardContent>
        </Card>
      ) : (
        <EmptyState title="Pick a file" description="Every source that runs the demo is in the tree." />
      )}
    </div>
  );
}

const mount = document.getElementById("impl-root");
if (mount) createRoot(mount).render(<App />);
`,"apps/stereos-site/page/index.template.html":`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="A real Smithers Sandbox running its child workflow inside a stereOS VM: a live demo on real VMs, the recorded evidence, and the implementation sources.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F9EA}</text></svg>">
<title>stereOS \xD7 Smithers</title>

<!-- The Proposed API reference document keeps its own stylesheet. build.mjs
     scopes every rule to #panel-api so it cannot reach the rest of the page. -->
<style>
__REFERENCE_STYLE__
</style>

<style>
  :root {
    --ink: #17231d; --muted: #65736b; --paper: #f4f1e8; --card: #fffef9;
    --line: #d7d8ce; --rule: rgba(23, 35, 29, .09);
    --orange: #ff6d2e; --orange-soft: #fff0e7;
    --green: #176b4b; --green-soft: #e4f4ec;
    --blue: #3767c8; --blue-soft: #e8eefc;
    --purple: #7753b4; --purple-soft: #f0eafd;
    --grid: rgba(23, 35, 29, .035);
    --diagram: #faf9f3; --diagram-line: #e4e3d9; --dot: #c7cbc2;
    --shadow: 0 14px 34px rgba(30, 43, 36, .07);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #e7ece7; --muted: #9aa79f; --paper: #12160f; --card: #1a1f18;
      --line: #2c3329; --rule: rgba(231, 236, 231, .12);
      --orange: #ff8a55; --orange-soft: #35211a;
      --green: #6ad3a4; --green-soft: #14271e;
      --blue: #8fb2ff; --blue-soft: #182031;
      --purple: #c0a4f0; --purple-soft: #221b30;
      --grid: rgba(231, 236, 231, .035);
      --diagram: #161b13; --diagram-line: #2c3329; --dot: #3b453a;
      --shadow: 0 14px 34px rgba(0, 0, 0, .35);
    }
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; color: var(--ink);
    background:
      radial-gradient(circle at 12% 0%, color-mix(in srgb, var(--orange) 12%, transparent), transparent 24rem),
      linear-gradient(var(--grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid) 1px, transparent 1px),
      var(--paper);
    background-size: auto, 28px 28px, 28px 28px, auto;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  button, input, select { font: inherit; }
  .shell { width: min(1180px, calc(100% - 40px)); margin: 0 auto; }
  a { color: var(--blue); }

  header.top { padding: 60px 0 26px; }
  .eyebrow { display: flex; align-items: center; gap: 10px; color: var(--orange);
    font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
  .eyebrow::before { content: ""; width: 28px; height: 2px; background: currentColor; }
  h1 { max-width: 900px; margin: 16px 0 12px; font-family: Georgia, "Times New Roman", serif;
    font-size: clamp(40px, 6vw, 74px); font-weight: 500; letter-spacing: -.05em; line-height: .95; }
  .lede { display: flex; justify-content: space-between; align-items: end; gap: 36px; flex-wrap: wrap; }
  .lede p { max-width: 620px; margin: 0; color: var(--muted); font-size: clamp(15px, 1.7vw, 19px); line-height: 1.5; }
  .stamp { flex: none; color: var(--muted); font-size: 12px; text-align: right; }
  .stamp strong { display: block; color: var(--ink); font-family: Georgia, serif; font-size: 32px; font-weight: 500; line-height: 1; }

  /* Tabs */
  .tabs { position: sticky; top: 0; z-index: 20; padding: 12px 0;
    background: color-mix(in srgb, var(--paper) 88%, transparent);
    border-block: 1px solid var(--rule); backdrop-filter: blur(14px); }
  .tabs-inner { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; }
  .tabs-inner::-webkit-scrollbar { display: none; }
  .tabs button { height: 38px; padding: 0 16px; white-space: nowrap; color: var(--muted);
    background: transparent; border: 1px solid transparent; border-radius: 999px; cursor: pointer; }
  .tabs button:hover { color: var(--ink); background: color-mix(in srgb, var(--card) 60%, transparent); }
  .tabs button[aria-selected="true"] { color: var(--paper); background: var(--ink); font-weight: 600; }
  [role="tabpanel"][hidden] { display: none; }

  main { padding: 34px 0 90px; }
  .section { margin-bottom: 46px; }
  .section-head { display: grid; grid-template-columns: 108px 1fr; align-items: baseline; gap: 18px; margin-bottom: 18px; }
  .section-index { color: var(--orange); font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em; }
  .section h2 { margin: 0; font: 500 clamp(24px, 3.2vw, 34px)/1.05 Georgia, serif; letter-spacing: -.03em; }
  .section h2 + .sub { margin: 6px 0 0; color: var(--muted); font-size: 14px; line-height: 1.5; }

  /* Cards */
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
  .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .card { min-width: 0; overflow: hidden; background: var(--card); border: 1px solid var(--line);
    border-radius: 16px; }
  .card-body { padding: 16px 18px; }
  .card h3 { margin: 0 0 6px; font-size: 16px; line-height: 1.2; letter-spacing: -.01em; }
  .card p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .kind { display: inline-block; padding: 4px 8px; border-radius: 999px; font-size: 10px;
    font-weight: 800; letter-spacing: .09em; text-transform: uppercase; }
  .kind.host { color: var(--blue); background: var(--blue-soft); }
  .kind.guest { color: var(--green); background: var(--green-soft); }
  .kind.live { color: var(--orange); background: var(--orange-soft); }

  /* KPI tiles */
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .kpi { padding: 12px 14px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; }
  .kpi dt { margin: 0 0 4px; color: var(--muted); font-size: 11px; font-weight: 700;
    letter-spacing: .08em; text-transform: uppercase; }
  .kpi dd { margin: 0; font: 500 15px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-word; }

  /* Diagram */
  .diagram { position: relative; padding: 14px; background: var(--diagram);
    border: 1px solid var(--diagram-line); border-radius: 16px; overflow: hidden; }
  .diagram::before { content: ""; position: absolute; inset: 0; opacity: .45;
    background-image: radial-gradient(var(--dot) 1px, transparent 1px); background-size: 14px 14px; }
  .diagram svg { position: relative; display: block; width: 100%; height: auto; overflow: visible; }
  .caption { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }

  /* Panes */
  .pane { background: var(--card); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
  .pane > header { display: flex; justify-content: space-between; align-items: center; gap: 12px;
    padding: 9px 14px; border-bottom: 1px solid var(--line); font-size: 12px; font-weight: 600; }
  .pane > header .muted { color: var(--muted); font-weight: 400; }
  .pane pre { margin: 0; padding: 12px 14px; overflow: auto; background: transparent;
    font: 11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }

  /* Steps */
  .steps { margin: 0; padding: 0; list-style: none; counter-reset: step; display: grid; gap: 10px; }
  .steps li { counter-increment: step; display: grid; grid-template-columns: 30px minmax(0, 1fr);
    gap: 12px; align-items: start; }
  .steps li::before { content: counter(step); display: grid; place-items: center; width: 28px; height: 28px;
    color: var(--orange); background: var(--orange-soft); border-radius: 999px;
    font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .steps h3 { margin: 4px 0 6px; font-size: 14px; font-weight: 600; }
  .steps pre { margin: 0; padding: 10px 12px; overflow-x: auto; background: var(--card);
    border: 1px solid var(--line); border-radius: 10px;
    font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }

  details.raw { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
    padding: 12px 16px; margin-bottom: 10px; }
  details.raw > summary { cursor: pointer; font-size: 13px; font-weight: 600; }
  details.raw pre { margin: 12px 0 0; max-height: 460px; overflow: auto;
    font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }

  .btn { height: 38px; padding: 0 16px; color: var(--paper); background: var(--ink);
    border: 1px solid var(--ink); border-radius: 999px; cursor: pointer; font-weight: 600; font-size: 13px; }
  .btn:hover:not(:disabled) { background: var(--orange); border-color: var(--orange); }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .btn.ghost { color: var(--ink); background: transparent; border-color: var(--line); }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

  .banner { display: flex; gap: 10px; align-items: flex-start; padding: 12px 16px; margin: 0 0 14px;
    border: 1px solid var(--line); border-radius: 12px; font-size: 13px; line-height: 1.5; background: var(--card); }
  .banner.warn { color: var(--ink); background: var(--orange-soft); border-color: var(--orange); }
  .banner[hidden] { display: none; }

  #demo-frame { width: 100%; height: 440px; border: 0; display: block; background: transparent; }
  #impl-root { min-height: 460px; }

  footer.bottom { padding: 24px 0 44px; color: var(--muted); border-top: 1px solid var(--rule); font-size: 12px; }
  footer.bottom .shell { display: flex; justify-content: space-between; gap: 20px; flex-wrap: wrap; }

  @media (max-width: 1000px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 720px) {
    .shell { width: min(100% - 24px, 1180px); }
    header.top { padding: 36px 0 20px; }
    .lede { align-items: start; flex-direction: column; gap: 16px; }
    .stamp { text-align: left; }
    .section-head { grid-template-columns: 1fr; gap: 4px; }
    .grid, .grid.two { grid-template-columns: 1fr; }
    #demo-frame { height: 520px; }
  }
</style>
</head>
<body>

<header class="top shell">
  <div class="eyebrow">stereOS \xD7 Smithers</div>
  <h1>Smithers inside a real VM</h1>
  <div class="lede">
    <p>A Smithers workflow executing inside a real stereOS VM. Live below.</p>
    <div class="stamp"><strong id="stamp-value">2.2 s</strong><span>warm run, host to guest and back</span></div>
  </div>
</header>

<nav class="tabs" aria-label="Sections">
  <div class="shell tabs-inner" role="tablist">
    <button role="tab" id="tab-live" aria-controls="panel-live" aria-selected="true" tabindex="0">Live demo</button>
    <button role="tab" id="tab-real" aria-controls="panel-real" aria-selected="false" tabindex="-1">How it works</button>
    <button role="tab" id="tab-impl" aria-controls="panel-impl" aria-selected="false" tabindex="-1">Implementation</button>
    <button role="tab" id="tab-api" aria-controls="panel-api" aria-selected="false" tabindex="-1">Proposed API</button>
  </div>
</nav>

<main>

<!-- \u2500\u2500 Live demo \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 -->
<div role="tabpanel" id="panel-live" aria-labelledby="tab-live">
<div class="shell">

  <div class="banner warn" id="offline-banner" hidden>
    <span>The demo host is unreachable, so nothing is running now. The
    <a href="#real" id="offline-link">recorded runs</a> are unedited captures of the same workflows.</span>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-index">01 / 03</span>
      <div>
        <h2>Start a run</h2>
        <p class="sub">Each button launches a real workflow on a booted stereOS VM.</p>
      </div>
    </div>

    <div class="diagram" id="flow-diagram">__FLOW_DIAGRAM__</div>
    <p class="caption">The engine stays on the host. The sandbox body runs in the guest.</p>

    <div class="row" style="margin: 16px 0 12px;">
      <button class="btn" id="run-hello" data-workflow="hello">hello</button>
      <button class="btn" id="run-pipeline" data-workflow="pipeline">pipeline</button>
      <button class="btn" id="run-approval" data-workflow="approval-demo">approval-demo</button>
      <span class="muted" id="live-status" style="color: var(--muted); font-size: 13px;">idle</span>
    </div>

    <div class="pane">
      <header><span>Run UI, served from the demo host</span><span class="muted" id="frame-note">connecting</span></header>
      <iframe id="demo-frame" title="stereOS demo runs" src="about:blank"></iframe>
    </div>
    <p class="caption">Built from <code>smthrs/ui</code> components. Approve here to release a parked run.</p>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-index">02 / 03</span>
      <div>
        <h2>Guest evidence</h2>
        <p class="sub">From the finished run's own output. The host is Debian on GCE.</p>
      </div>
    </div>
    <dl class="kpis" id="live-kpis">
      <div class="kpi"><dt>Guest host</dt><dd id="kpi-host">\u2014</dd></div>
      <div class="kpi"><dt>Guest kernel</dt><dd id="kpi-kernel">\u2014</dd></div>
      <div class="kpi"><dt>Guest OS</dt><dd id="kpi-os">\u2014</dd></div>
      <div class="kpi"><dt>Guest runtime</dt><dd id="kpi-bun">\u2014</dd></div>
      <div class="kpi"><dt>Run duration</dt><dd id="kpi-elapsed">\u2014</dd></div>
      <div class="kpi"><dt>Write outside workspace</dt><dd id="kpi-restrict">\u2014</dd></div>
    </dl>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-index">03 / 03</span>
      <div>
        <h2>What the edge allows</h2>
        <p class="sub">A guard exposes four routes. The Smithers RPC surface is not public.</p>
      </div>
    </div>
    <div class="grid">
      <div class="card"><div class="card-body"><span class="kind live">Allowlist</span>
        <h3>Three workflow ids</h3><p>Input is chosen server-side.</p></div></div>
      <div class="card"><div class="card-body"><span class="kind live">Capacity</span>
        <h3>2 concurrent, queued</h3><p>Extra starts queue. Per IP: 6 starts per 10 minutes.</p></div></div>
      <div class="card"><div class="card-body"><span class="kind live">Authority</span>
        <h3>Per-run approval token</h3><p>256 bits, compared in constant time.</p></div></div>
      <div class="card"><div class="card-body"><span class="kind live">Lifetime</span>
        <h3>5 minute ceiling</h3><p>The guard cancels anything that outlives it.</p></div></div>
      <div class="card"><div class="card-body"><span class="kind live">Transport</span>
        <h3>Outbound tunnel only</h3><p>cloudflared dials out. No inbound port.</p></div></div>
      <div class="card"><div class="card-body"><span class="kind live">Isolation</span>
        <h3>Loopback gateway</h3><p>Bearer token in a root-owned 0600 file.</p></div></div>
    </div>
  </div>

</div>
</div>

<!-- \u2500\u2500 How it works \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 -->
<div role="tabpanel" id="panel-real" aria-labelledby="tab-real" hidden>
<div class="shell">

  <div class="section">
    <div class="section-head">
      <span class="section-index">01 / 04</span>
      <div>
        <h2>Two hosts, one provider</h2>
        <p class="sub">Recorded 2026-08-12, committed beside the code that produced them.</p>
      </div>
    </div>
    <div class="diagram">__FLOW_DIAGRAM__</div>
    <p class="caption">The path both recordings take.</p>
    <div class="grid two" id="host-cards" style="margin-top: 14px;"></div>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-index">02 / 04</span>
      <div>
        <h2>One run, step by step</h2>
        <p class="sub">Every excerpt is lifted from the committed x86_64 KVM capture.</p>
      </div>
    </div>
    <ol class="steps" id="walkthrough"></ol>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-index">03 / 04</span>
      <div>
        <h2>Full captures</h2>
        <p class="sub">Unedited terminal output, one per host.</p>
      </div>
    </div>
    <div id="raw-captures"></div>
  </div>

  <div class="section">
    <div class="section-head">
      <span class="section-index">04 / 04</span>
      <div>
        <h2>Found while building this</h2>
        <p class="sub">A registry defect that blocks <code>mb pull coder-arm64:latest</code>.</p>
      </div>
    </div>
    <div class="grid two">
      <div class="card"><div class="card-body"><span class="kind host">Served blob</span>
        <h3><code style="font-size:12px">d335283a5c0c9fde\u2026</code></h3>
        <p>752,461,648 stable bytes. <code>zstd -t</code> reports <code>Decoding error (36): Data corruption detected</code>.</p></div></div>
      <div class="card"><div class="card-body"><span class="kind guest">Declared digest</span>
        <h3><code style="font-size:12px">bf212e026f722ccc\u2026</code></h3>
        <p>The qcow2 blob at the same tag is clean and rebuilds the expected image. Republishing the one raw blob fixes the pull.</p></div></div>
    </div>
  </div>

</div>
</div>

<!-- \u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 -->
<div role="tabpanel" id="panel-impl" aria-labelledby="tab-impl" hidden>
<div class="shell">
  <div class="section">
    <div class="section-head">
      <span class="section-index">01 / 01</span>
      <div>
        <h2>Every source that runs this</h2>
        <p class="sub">Provider, guest workflows, demo service, and this page. Read from the repository at build time.</p>
      </div>
    </div>
    <div id="impl-root"></div>
  </div>
</div>
</div>

<!-- \u2500\u2500 Proposed API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 -->
<div role="tabpanel" id="panel-api" aria-labelledby="tab-api" hidden>
__REFERENCE_MAIN__
</div>

</main>

<footer class="bottom">
  <div class="shell">
    <span>Sources: <a href="https://github.com/smithersai/smithers/tree/main/apps/stereos-site">apps/stereos-site</a>. Parts of the Proposed API tab marked proposed do not exist.</span>
    <span>An earlier tab ran this engine under plain Node in a WebContainer, kept at <a href="https://github.com/smithersai/smithers/tree/main/apps/stereos-site/project">project/</a> and <a href="https://github.com/smithersai/smithers/pull/1506">PR #1506</a>.</span>
  </div>
</footer>

<script type="module" src="./live.js?v=__BUILD__"><\/script>
<script type="module" src="./evidence.js?v=__BUILD__"><\/script>
<script type="module" src="./impl.js?v=__BUILD__"><\/script>
<script>
  const tabs = ['live', 'real', 'impl', 'api'].map((key) => ({
    hash: \`#\${key}\`,
    tab: document.getElementById(\`tab-\${key}\`),
    panel: document.getElementById(\`panel-\${key}\`),
  }));
  function selectTab(entry, { focus = false, updateHash = true } = {}) {
    for (const other of tabs) {
      const selected = other === entry;
      other.tab.setAttribute('aria-selected', String(selected));
      other.tab.tabIndex = selected ? 0 : -1;
      other.panel.hidden = !selected;
    }
    if (focus) entry.tab.focus();
    if (updateHash) history.replaceState(null, '', entry.hash);
    window.dispatchEvent(new CustomEvent('stereos-tab', { detail: entry.hash.slice(1) }));
  }
  for (const entry of tabs) {
    entry.tab.addEventListener('click', () => selectTab(entry));
    entry.tab.addEventListener('keydown', (event) => {
      const current = tabs.indexOf(entry);
      let target = null;
      if (event.key === 'ArrowRight') target = tabs[(current + 1) % tabs.length];
      if (event.key === 'ArrowLeft') target = tabs[(current - 1 + tabs.length) % tabs.length];
      if (event.key === 'Home') target = tabs[0];
      if (event.key === 'End') target = tabs[tabs.length - 1];
      if (target) {
        event.preventDefault();
        selectTab(target, { focus: true });
      }
    });
  }
  document.getElementById('offline-link')?.addEventListener('click', (event) => {
    event.preventDefault();
    selectTab(tabs[1]);
  });
  const opening = tabs.find((entry) => entry.hash === location.hash) ?? tabs[0];
  selectTab(opening, { updateHash: Boolean(location.hash) });
<\/script>
</body>
</html>
`,"apps/stereos-site/page/live.js":`// Live demo tab: start real runs on the demo host and show what the guest reported.
//
// The page never talks to a Smithers gateway. It talks to the guard, whose
// public surface is four routes. The guard is published through a cloudflared
// tunnel, so the host has no inbound port.
//
// Backend discovery, in order:
//   1. https://stereos-api.smithers.sh - the stable named-tunnel hostname.
//   2. The TXT record _stereos-api.smithers.sh, resolved over DNS-over-HTTPS.
//      The tunnel unit writes its current hostname there on every start, so a
//      restarted quick tunnel is found without redeploying this page.
//
// If neither answers, the tab says so and points at the recorded runs. It never
// shows a fabricated run.

const STABLE = "https://stereos-api.smithers.sh";
const DISCOVERY = "_stereos-api.smithers.sh";
const TERMINAL = new Set(["finished", "failed", "cancelled", "canceled", "error"]);

const banner = document.getElementById("offline-banner");
const statusLine = document.getElementById("live-status");
const frameNote = document.getElementById("frame-note");
const frame = document.getElementById("demo-frame");
const buttons = [...document.querySelectorAll("[data-workflow]")];

const kpi = {
  host: document.getElementById("kpi-host"),
  kernel: document.getElementById("kpi-kernel"),
  os: document.getElementById("kpi-os"),
  bun: document.getElementById("kpi-bun"),
  elapsed: document.getElementById("kpi-elapsed"),
  restrict: document.getElementById("kpi-restrict"),
};

let base = null;
let token = null;
let pollTimer = null;

const setStatus = (text) => {
  statusLine.textContent = text;
};

/** Ask a candidate origin whether it is a healthy guard. */
async function probe(origin) {
  try {
    const response = await fetch(\`\${origin}/api/health\`, {
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const health = await response.json();
    return health?.ok === true ? origin : null;
  } catch {
    return null;
  }
}

/** Read the current backend hostname the tunnel unit published to DNS. */
async function discover() {
  try {
    const response = await fetch(\`https://cloudflare-dns.com/dns-query?name=\${DISCOVERY}&type=TXT\`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(6000),
    });
    const body = await response.json();
    const answer = body?.Answer?.find((entry) => typeof entry.data === "string");
    if (!answer) return null;
    const host = answer.data.replace(/^"|"$/g, "").trim();
    return /^[a-z0-9.-]+$/i.test(host) ? \`https://\${host}\` : null;
  } catch {
    return null;
  }
}

async function connect() {
  base = await probe(STABLE);
  if (!base) {
    const discovered = await discover();
    if (discovered) base = await probe(discovered);
  }
  if (!base) {
    banner.hidden = false;
    frameNote.textContent = "host unreachable";
    setStatus("demo host unreachable");
    for (const button of buttons) button.disabled = true;
    return false;
  }
  banner.hidden = true;
  frame.src = base;
  frameNote.textContent = "connected";
  setStatus("ready");
  return true;
}

function showGuest(run) {
  const guest = run?.result?.guest;
  if (!guest) return;
  kpi.host.textContent = guest.hostname ?? "\u2014";
  kpi.kernel.textContent = guest.kernel ?? "\u2014";
  kpi.os.textContent = guest.os ?? "\u2014";
  kpi.bun.textContent = guest.bun ? \`Bun \${guest.bun} \${guest.arch ?? ""}\`.trim() : "\u2014";
  kpi.elapsed.textContent = typeof run.elapsedMs === "number" ? \`\${run.elapsedMs} ms\` : "\u2014";
  kpi.restrict.textContent = guest.writeOutsideWorkspace ?? "\u2014";
}

function poll(runId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const run = await (await fetch(\`\${base}/api/runs/\${runId}\`, { cache: "no-store" })).json();
      if (run.error) return;
      setStatus(run.status === "waiting-approval" ? "waiting for your approval, click Approve below" : run.status);
      if (TERMINAL.has(run.status)) {
        clearInterval(pollTimer);
        showGuest(run);
        for (const button of buttons) button.disabled = false;
      }
    } catch {
      // Transient; the next tick retries.
    }
  }, 1000);
}

async function start(workflow) {
  if (!base && !(await connect())) return;
  for (const button of buttons) button.disabled = true;
  setStatus(\`starting \${workflow}\`);
  for (const value of Object.values(kpi)) value.textContent = "\u2014";
  try {
    const response = await fetch(\`\${base}/api/runs\`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow }),
    });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error ?? \`start failed (\${response.status})\`);
    token = body.token;
    // Keep the embedded UI on the same run, so its Approve button resolves it.
    frame.contentWindow?.postMessage({ type: "stereos-adopt", runId: body.runId, token, workflow }, "*");
    setStatus(body.queuePosition > 0 ? \`queued at position \${body.queuePosition}\` : "running");
    poll(body.runId);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
    for (const button of buttons) button.disabled = false;
  }
}

for (const button of buttons) {
  button.addEventListener("click", () => start(button.dataset.workflow));
}

// The embedded UI reports every state change, so a run started inside the frame
// updates this tab's status line and evidence tiles too.
window.addEventListener("message", (event) => {
  if (base && event.origin !== new URL(base).origin) return;
  const data = event.data;
  if (!data || data.type !== "stereos-state") return;
  if (data.status && data.status !== "idle") setStatus(data.status);
  if (data.guest) {
    showGuest({ result: { guest: data.guest }, elapsedMs: data.elapsedMs });
  }
});

connect();
`,"apps/stereos-site/real/README.md":`# Running Smithers inside a real stereOS VM

This directory boots actual stereOS mixtapes and runs the bundled Smithers
\`<Sandbox>\` child workflow inside them. The two transcripts are raw terminal
captures from runs recorded on 2026-08-12. The Real stereOS tab at
https://stereos.smithers.sh renders those files directly.

| Host | Mixtape | Hypervisor | Result |
| --- | --- | --- | --- |
| Apple Silicon Mac | \`coder-arm64:latest\`, fetched by hand (see Registry defect) | Apple Virtualization.framework through \`mb\` | \`finished\`; SandboxCreated to SandboxCompleted: 768 ms |
| GCE n2-standard-2 with nested virtualization | \`coder-dev\` x86_64, built from source | QEMU/KVM | \`finished\`; SandboxCreated to SandboxCompleted: 1,877 ms |

| File | Purpose |
| --- | --- |
| \`stereos-provider.ts\` | \`createCommandSandboxProvider\` plus an SSH \`SandboxSession\`; bundles and uploads the child workflow. |
| \`guest-runner.sh\` | Thirteen-line guest launcher that invokes Bun. It does not construct results. |
| \`child-workflow.tsx\` | Real guest work: facts, restriction probes, prompt consistency hash, and a prime sieve. Bun writes all result JSON with \`JSON.stringify\`. |
| \`stereos-real.tsx\` | Host workflow containing one \`<Sandbox>\`. |
| \`bootstrap-vm.sh\` | Keys the arm64 guest and copies the pinned Bun musl runtime into it. |
| \`provision-linux-host.sh\` | Prepares a fresh nested-virtualization Linux host and builds the x86_64 mixtape. |
| \`run-on-linux-host.sh\` | Checks KVM access, boots QEMU, copies x86_64 Bun into the guest, and runs Smithers from source. |
| \`transcript.txt\`, \`transcript-linux.txt\` | Unedited command/output captures rendered on the site. |

## Apple Silicon recipe

Install the host tools and use the explicit \`mb\` path. \`~/.local/bin\` need not
already exist or be on \`PATH\`.

\`\`\`sh
brew install qemu zstd
mkdir -p "$HOME/.local/bin" "$HOME/.config/stereos"
curl -fsSL https://mb.stereos.ai/latest/darwin/arm64/mb -o "$HOME/.local/bin/mb"
chmod +x "$HOME/.local/bin/mb"
test -f "$HOME/.config/stereos/ssh-key" || \\
  ssh-keygen -t ed25519 -f "$HOME/.config/stereos/ssh-key" -N ""
\`\`\`

\`mb pull coder-arm64:latest\` currently fails. Fetch the clean qcow2 blob and
the remaining manifest objects, then convert the qcow2 image to raw:

\`\`\`sh
REG=https://download.stereos.ai/v2/mixtapes/coder-arm64
DEST="$HOME/.config/mb/mixtapes/coder-arm64/latest"
mkdir -p "$DEST"
curl -fsSL "$REG/blobs/sha256:2cc5b9dd3b3a27e891aef218156a701200c3654adf0df5db258a828fa6a2527d" \\
  | zstd -d -o "$DEST/stereos.qcow2"
qemu-img convert -f qcow2 -O raw "$DEST/stereos.qcow2" "$DEST/stereos.img"
for d in 65484645bb276f557635de6757abae2080e002c979afdcf1602a7c3c20f3eecd:bzImage \\
         2c7d77b38353ce630296f8d3c94cf0c2588c438d0c0f0dfe34ada415e6ac4fb1:initrd \\
         145af2f7943439a5083410b550c441c8095ea5087d54f28fbf03caf5104e00c6:cmdline \\
         0e33109de96b56886b68f3230443633a9a3aa66166d319384a5fc43c39c5e0b7:init \\
         c89c84a26e66ee37eb7f7321e31126b485b4b4a6d123839c49f09f84f2298645:mixtape.toml; do
  curl -fsSL "$REG/blobs/sha256:\${d%%:*}" -o "$DEST/\${d##*:}"
done
EXPECTED=6b8ba3e7113988318ebbc3887c71835db5e2e33a6e8c9264e57e8bd84de786ce
ACTUAL=$(shasum -a 256 "$DEST/stereos.img" | awk '{print $1}')
test "$ACTUAL" = "$EXPECTED" && printf 'digest verified: %s\\n' "$ACTUAL" || {
  printf 'digest mismatch: expected %s, got %s\\n' "$EXPECTED" "$ACTUAL" >&2
  exit 1
}
\`\`\`

Boot, install the guest runtime, and run the source CLI:

\`\`\`sh
cd apps/stereos-site/real
"$HOME/.local/bin/mb" up
eval "$(MB="$HOME/.local/bin/mb" ./bootstrap-vm.sh)"
env -u ANTHROPIC_API_KEY bun ../../../apps/cli/src/index.js up stereos-real.tsx \\
  --input '{"prompt":"hello from the host"}'
\`\`\`

## Bun inside the guest

Mixtapes contain no Bun or Node runtime. Both host scripts download the pinned
official Bun 1.2.21 musl archive for the guest architecture. NixOS also lacks
the generic musl loader path, so the scripts copy the loader and the matching
Alpine \`libstdc++\` and \`libgcc\` files into \`/home/agent/.local\` and install a
small wrapper. The arm64 and x86_64 guests both report Bun 1.2.21.

The provider bundles the exact \`child-workflow.tsx\` module with \`Bun.build\`,
uploads it beside the provider request, and runs \`guest-runner.sh\`. That script
only validates the runtime and bundle paths before invoking Bun. Bun reads the
request, executes \`executeGuestWork\`, and writes the complete result with
\`JSON.stringify\`. \`jqOnPath: true\` confirms the mixtapes include \`jq\`, but jq is
not needed for result construction. Strings with quotes, backslashes, newlines,
tabs, and control characters remain valid JSON.

## Fresh Linux/KVM host

The reference host is \`stereos-smithers-demo\`, n2-standard-2, 100 GB
pd-balanced, \`us-east1-b\`, project \`plue-prod-1771780303\`, with nested
virtualization enabled. No gateway or anonymous run endpoint is exposed.

First obtain this example at the pinned engineering commit:

\`\`\`sh
git clone https://github.com/smithersai/smithers.git "$HOME/smithers"
git -C "$HOME/smithers" checkout cd58efd6245f829ed16ef960394f651fed661706
cd "$HOME/smithers"
\`\`\`

Prepare and run the host:

\`\`\`sh
./apps/stereos-site/real/provision-linux-host.sh
pnpm install --frozen-lockfile
cd apps/stereos-site/real
./run-on-linux-host.sh
\`\`\`

\`provision-linux-host.sh\` installs QEMU/KVM, Nix, Bun, pnpm, and build tools,
then builds \`coder-dev\` x86_64 from source. The published registry has no
x86_64 tag. The script verifies read and write access to \`/dev/kvm\`; after
adding the user to \`kvm\`, it re-enters through \`sg kvm\` so the current run gets
the new supplementary group. \`run-on-linux-host.sh\` performs the same check
before QEMU starts.

The build takes about 25 minutes on 2 vCPU and produces a 1.01 GiB qcow2. It
needs Determinate Nix with systemd initialization, \`make\`, a copy-on-write
overlay over the read-only Nix store image, and OVMF pflash drives for GRUB.

## Registry defect

\`mb pull coder-arm64:latest\` fails with
\`decompressing stereos.img.zst: corrupt stream, did not find end of stream\`.
The registry returns 752,461,648 stable bytes with sha256
\`d335283a5c0c9fdeef22fe48740cb74d0c973b69373bef651e76aaac012a21e2\`.
The manifest and response header declare
\`bf212e026f722ccccd30f273d363f9b8a7245516f7bc1e8d81db67b41245cdeb\`.
\`zstd -t\` reports \`Decoding error (36): Data corruption detected\`.

The qcow2 blob at the same tag matches its digest, and converting it produces
the declared uncompressed raw digest shown above. Republishing the one raw
blob makes \`mb pull\` work. This is a narrow registry artifact issue, not an
image-content or \`mb\` defect.

## Integration gaps

6. \`mb up\` injects the host key for \`admin\`, not \`agent\`. The bootstrap uses a
   fixed remote \`tee\` command and sends the public key through stdin.
7. The restricted PATH comes from the agent login shell. Non-interactive SSH
   sees the system profile and reports \`nixCli: on PATH\`; filesystem writes
   outside the workspace remain denied.
8. The registry publishes no x86_64 mixtape, so Linux/KVM requires a source
   build.
9. The raw arm64 blob needs republishing as described above.
10. A mixtape with Bun already present would remove the runtime copy step.

## Reading the evidence

Both runs report the child workflow marker, Bun version and architecture,
guest OS and kernel, restriction probes, a prompt-derived prime computation,
the full provider run ID, and the sandbox ID. The event listing gives the exact
\`SandboxCreated\` to \`SandboxCompleted\` timing.

\`promptSha256\` is consistency evidence only. The same prompt produces the same
hash on any machine, so the hash does not prove provenance or guest execution.
The captures do not claim attestation. They show the exact executable commands,
the Smithers event lifecycle, and the result returned through the guest
request/result transport. The source and raw captures are committed together
so those claims can be audited.
`,"apps/stereos-site/real/bootstrap-vm.sh":`#!/usr/bin/env bash
# bootstrap-vm.sh \u2014 make an mb-booted stereOS VM reachable by the Smithers provider.
#
# masterblaster boots the VM and injects an SSH key over the stereosd control
# plane, but it wires that key to the admin user only. The Smithers provider
# connects as agent, the restricted user, so this script installs the stereos
# public key into /home/agent/.ssh/authorized_keys over the admin channel.
#
# Drop this script once masterblaster injects keys for the agent user too
# (integration gap #6 in real/README.md).
#
# Usage: real/bootstrap-vm.sh [vm-name]        # default: smithers-stereos
# Prints the environment the provider reads.

set -euo pipefail

VM="\${1:-smithers-stereos}"
MB="\${MB:-mb}"
STEREOS_KEY="\${STEREOS_SSH_KEY:-$HOME/.config/stereos/ssh-key}"
ADMIN_KEY="$HOME/.config/mb/vms/$VM/ssh_key"
BUN_VERSION="\${STEREOS_BUN_VERSION:-1.2.21}"
BUN_CACHE="$HOME/.cache/stereos-bun/v$BUN_VERSION"
ALPINE_VERSION="3.24.1"
ALPINE_ROOTFS_SHA256="f55a90f69052c5bd6f92cb09a8f47065970830b194c917a006fb94028e721259"
ALPINE_GCC_VERSION="15.2.0-r5"

[ -f "$STEREOS_KEY.pub" ] || {
  echo "no stereos key at $STEREOS_KEY.pub; run: ssh-keygen -t ed25519 -f $STEREOS_KEY -N ''" >&2
  exit 1
}
[ -f "$ADMIN_KEY" ] || { echo "no mb key at $ADMIN_KEY; is '$VM' up? try: $MB up" >&2; exit 1; }

port=$("$MB" status "$VM" 2>/dev/null | sed -n 's/.*127\\.0\\.0\\.1:\\([0-9]*\\).*/\\1/p' | head -1)
[ -n "$port" ] || { echo "could not read an SSH port from: $MB status $VM" >&2; exit 1; }

ssh_admin() {
  ssh -p "$port" -i "$ADMIN_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
    -o LogLevel=ERROR -o IdentitiesOnly=yes admin@127.0.0.1 "$@"
}

cat "$STEREOS_KEY.pub" | ssh_admin 'sudo install -d -m 700 -o agent -g agent /home/agent/.ssh \\
  && sudo tee /home/agent/.ssh/authorized_keys >/dev/null \\
  && sudo chown agent:agent /home/agent/.ssh/authorized_keys \\
  && sudo chmod 600 /home/agent/.ssh/authorized_keys'

# Mixtapes intentionally omit a JS runtime. Download the pinned official Linux
# arm64 Bun build on the host, then install it in the guest through the already
# authenticated admin channel.
mkdir -p "$BUN_CACHE"
if [ ! -x "$BUN_CACHE/bun-linux-aarch64-musl/bun" ]; then
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-aarch64-musl.zip" \\
    -o "$BUN_CACHE/bun-linux-aarch64-musl.zip"
  unzip -oq "$BUN_CACHE/bun-linux-aarch64-musl.zip" -d "$BUN_CACHE"
fi
if [ ! -x "$BUN_CACHE/lib/ld-musl-aarch64.so.1" ]; then
  rootfs="$BUN_CACHE/alpine-minirootfs-$ALPINE_VERSION-aarch64.tar.gz"
  curl -fsSL "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/$(basename "$rootfs")" -o "$rootfs"
  printf '%s  %s\\n' "$ALPINE_ROOTFS_SHA256" "$rootfs" | shasum -a 256 -c -
  tar -xzf "$rootfs" -C "$BUN_CACHE" ./lib/ld-musl-aarch64.so.1
fi
if [ ! -f "$BUN_CACHE/usr/lib/libstdc++.so.6.0.34" ]; then
  for package in libstdc++ libgcc; do
    apk="$BUN_CACHE/$package-$ALPINE_GCC_VERSION.apk"
    curl -fsSL "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/$(basename "$apk")" -o "$apk"
    tar -xf "$apk" -C "$BUN_CACHE" usr/lib
  done
fi
scp -q -P "$port" -i "$ADMIN_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/bun-linux-aarch64-musl/bun" \\
  admin@127.0.0.1:/tmp/stereos-bun-bin
scp -q -P "$port" -i "$ADMIN_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/lib/ld-musl-aarch64.so.1" \\
  admin@127.0.0.1:/tmp/stereos-musl-loader
scp -q -P "$port" -i "$ADMIN_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/usr/lib/libstdc++.so.6.0.34" \\
  admin@127.0.0.1:/tmp/stereos-libstdc++.so.6
scp -q -P "$port" -i "$ADMIN_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/usr/lib/libgcc_s.so.1" \\
  admin@127.0.0.1:/tmp/stereos-libgcc_s.so.1
ssh_admin 'sudo install -d -m 755 -o agent -g agent /home/agent/.local/bin /home/agent/.local/lib \\
  && sudo install -m 755 -o agent -g agent /tmp/stereos-bun-bin /home/agent/.local/bin/bun-bin \\
  && sudo install -m 755 -o agent -g agent /tmp/stereos-musl-loader /home/agent/.local/lib/ld-musl-aarch64.so.1 \\
  && sudo install -m 644 -o agent -g agent /tmp/stereos-libstdc++.so.6 /home/agent/.local/lib/libstdc++.so.6 \\
  && sudo install -m 644 -o agent -g agent /tmp/stereos-libgcc_s.so.1 /home/agent/.local/lib/libgcc_s.so.1 \\
  && rm -f /tmp/stereos-bun-bin /tmp/stereos-musl-loader /tmp/stereos-libstdc++.so.6 /tmp/stereos-libgcc_s.so.1' \\
  </dev/null
cat <<'WRAPPER' | ssh_admin 'sudo tee /home/agent/.local/bin/bun >/dev/null && sudo chown agent:agent /home/agent/.local/bin/bun && sudo chmod 755 /home/agent/.local/bin/bun'
#!/bin/sh
export LD_LIBRARY_PATH=/home/agent/.local/lib
exec /home/agent/.local/lib/ld-musl-aarch64.so.1 /home/agent/.local/bin/bun-bin "$@"
WRAPPER

ssh -n -p "$port" -i "$STEREOS_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
  -o LogLevel=ERROR -o IdentitiesOnly=yes agent@127.0.0.1 '/home/agent/.local/bin/bun --version' >&2

echo "agent login verified on $VM (127.0.0.1:$port)" >&2
echo "export STEREOS_SSH_PORT=$port"
echo "export STEREOS_SSH_KEY=$STEREOS_KEY"
`,"apps/stereos-site/real/child-workflow.tsx":`/** @jsxImportSource smthrs */
/**
 * The child workflow that runs inside the stereOS guest.
 *
 * The provider bundles this exact module on the host, uploads that bundle, and
 * guest-runner.sh executes it with the guest's Bun binary. The Task and the
 * protocol entrypoint call the same executeGuestWork function.
 */
import { createSmithers } from "smthrs";
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { z } from "zod";

export const guestResultSchema = z.object({
  summary: z.string(),
  prompt: z.string(),
  promptSha256: z.string(),
  guest: z.record(z.string(), z.unknown()),
  restrictions: z.record(z.string(), z.string()),
  harnessesOnPath: z.string(),
  execution: z.object({
    workflow: z.string(),
    runtime: z.string(),
    jsonEmitter: z.string(),
    jqOnPath: z.boolean(),
  }),
  computation: z.object({
    upperBound: z.number(),
    primeCount: z.number(),
    primeSum: z.number(),
    lastPrime: z.number(),
  }),
  protocolRunId: z.string(),
  protocolSandboxId: z.string(),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ prompt: z.string() }),
  result: guestResultSchema,
});

function command(...argv: string[]) {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return "";
  return result.stdout.toString().trim();
}

function osName() {
  try {
    const fields = Object.fromEntries(
      readFileSync("/etc/os-release", "utf8")
        .split("\\n")
        .filter((line: string) => line.includes("="))
        .map((line: string) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1).replace(/^['\\"]|['\\"]$/g, "")];
        }),
    );
    return \`\${fields.NAME ?? "unknown"} \${fields.VERSION ?? ""}\`.trim();
  } catch {
    return "unknown";
  }
}

function primesThrough(upperBound: number) {
  const composite = new Uint8Array(upperBound + 1);
  let primeCount = 0;
  let primeSum = 0;
  let lastPrime = 0;
  for (let candidate = 2; candidate <= upperBound; candidate += 1) {
    if (composite[candidate]) continue;
    primeCount += 1;
    primeSum += candidate;
    lastPrime = candidate;
    if (candidate * candidate <= upperBound) {
      for (let multiple = candidate * candidate; multiple <= upperBound; multiple += candidate) {
        composite[multiple] = 1;
      }
    }
  }
  return { upperBound, primeCount, primeSum, lastPrime };
}

async function canWrite(path: string) {
  try {
    await Bun.write(path, "stereOS write probe\\n");
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

/** The non-trivial child-workflow body. This function executes only in-guest. */
export async function executeGuestWork(prompt: string, protocol: { runId: string; sandboxId: string }) {
  const promptBytes = new TextEncoder().encode(prompt);
  const upperBound = 20_000 + (promptBytes.reduce((sum, byte) => sum + byte, 0) % 5_000);
  const kernel = command("uname", "-srm");
  const user = command("id", "-un");
  const hostname = command("hostname");
  const uptimeSeconds = Number(command("sh", "-c", "cut -d' ' -f1 /proc/uptime 2>/dev/null")) || 0;
  const memTotalKb = Number(command("sh", "-c", "awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null")) || 0;
  const harnesses = ["claude", "opencode", "gemini"].filter((name) => Boolean(Bun.which(name)));
  const promptSha256 = new Bun.CryptoHasher("sha256").update(prompt).digest("hex");

  return {
    summary: \`child workflow executed inside stereOS as \${user}@\${hostname} on \${kernel}\`,
    prompt,
    promptSha256,
    guest: {
      os: osName(),
      kernel,
      user,
      hostname,
      uptimeSeconds,
      cpus: Number(command("nproc")) || 0,
      memTotalKb,
    },
    restrictions: {
      writeOutsideWorkspace: (await canWrite("/etc/stereos-write-probe")) ? "ALLOWED (unexpected)" : "denied",
      writeInsideWorkspace: (await canWrite(\`\${process.env.HOME ?? "/home/agent"}/workspace/.stereos-write-probe\`))
        ? "allowed"
        : "DENIED (unexpected)",
      nixCli: Bun.which("nix") ? "on PATH" : "not on PATH",
      nixStorePresent: existsSync("/nix/store") ? "yes" : "no",
    },
    harnessesOnPath: harnesses.join(" ") || "none-on-path",
    execution: {
      workflow: "stereos-guest-work/guest-facts",
      runtime: \`Bun \${Bun.version} \${process.arch}\`,
      jsonEmitter: "Bun JSON.stringify",
      jqOnPath: Boolean(Bun.which("jq")),
    },
    computation: primesThrough(upperBound),
    protocolRunId: protocol.runId,
    protocolSandboxId: protocol.sandboxId,
  };
}

export default smithers((ctx) => (
  <Workflow name="stereos-guest-work">
    <Task id="guest-facts" output={outputs.result}>
      {() => executeGuestWork(ctx.input.prompt, { runId: "smithers-child", sandboxId: "stereos-vm" })}
    </Task>
  </Workflow>
));

// createCommandSandboxProvider writes the request path into the environment.
// Bun runs this bundled module as the guest entrypoint and this branch writes
// the provider result. Importing the module on the host does not enter it.
if (import.meta.main) {
  const requestPath = process.env.SMITHERS_SANDBOX_REQUEST_PATH;
  const resultPath = process.env.SMITHERS_SANDBOX_RESULT_PATH;
  if (!requestPath || !resultPath) throw new Error("Smithers sandbox protocol paths are unset");
  const request = await Bun.file(requestPath).json();
  const prompt = z.string().parse(request.input?.prompt);
  const output = await executeGuestWork(prompt, {
    runId: z.string().parse(request.runId),
    sandboxId: z.string().parse(request.sandboxId),
  });
  const result = JSON.stringify({ status: "finished", output });
  await Bun.write(resultPath, result);
  process.stdout.write(\`\${result}\\n\`);
}
`,"apps/stereos-site/real/guest-runner.sh":`#!/bin/sh
# Execute the bundled child workflow with the official Bun binary installed by
# bootstrap-vm.sh (arm64) or run-on-linux-host.sh (x86_64).

set -eu

BUN_PATH="\${STEREOS_GUEST_BUN:-/home/agent/.local/bin/bun}"
WORKFLOW_PATH="\${STEREOS_GUEST_WORKFLOW:-/home/agent/workspace/.smithers/child-workflow.js}"

[ -x "$BUN_PATH" ] || { echo "guest Bun is missing or not executable: $BUN_PATH" >&2; exit 127; }
[ -r "$WORKFLOW_PATH" ] || { echo "guest child workflow is missing: $WORKFLOW_PATH" >&2; exit 127; }

exec "$BUN_PATH" "$WORKFLOW_PATH"
`,"apps/stereos-site/real/jcard.toml":`# jcard.toml \u2014 the stereOS VM that Smithers runs sandbox bodies inside.
#
# Boot it with \`mb up\` from this directory. masterblaster resolves the mixtape
# from the local store (~/.config/mb/mixtapes); see real/README.md for how to
# populate that store, since \`mb pull\` cannot fetch this mixtape today.
mixtape = "coder-arm64:latest"
name = "smithers-stereos"

[resources]
cpus   = 4
memory = "4GiB"
disk   = "20GiB"

[network]
mode = "nat"

# No [[agents]] block: Smithers drives the work over the provider's exec
# channel, so agentd should not auto-launch a harness at boot.
`,"apps/stereos-site/real/provision-linux-host.sh":`#!/usr/bin/env bash
# provision-linux-host.sh \u2014 turn a fresh nested-virt Linux box into a stereOS
# execution host for Smithers.
#
# Run on the host itself (Debian 12 / Ubuntu, x86_64, /dev/kvm present):
#   scp real/provision-linux-host.sh box: && ssh box 'bash provision-linux-host.sh'
#
# Installs QEMU/KVM, Nix, and Bun, then builds the x86_64 coder-dev mixtape
# from source. A source build is required because the Paper Compute registry
# publishes no x86_64 mixtape: \`mb mixtapes list coder-x86\` returns no tags.
#
# The build bakes ~/.config/stereos/ssh-key.pub into the image (profiles/dev.nix),
# so generate or copy that key before running this.

set -euo pipefail
log() { printf '\\n=== %s ===\\n' "$*"; }

[ -e /dev/kvm ] || { echo "no /dev/kvm: this host has no hardware virtualization" >&2; exit 1; }

log "packages"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \\
  qemu-system-x86 qemu-utils git curl xz-utils unzip jq make nodejs npm >/dev/null
sudo adduser "$USER" kvm >/dev/null 2>&1 || true

if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
  if [ "\${STEREOS_KVM_REEXEC:-0}" != 1 ]; then
    echo "re-entering this script with the new kvm group" >&2
    exec sg kvm -c "STEREOS_KVM_REEXEC=1 bash $(printf '%q' "$0")"
  fi
  echo "current shell still cannot read and write /dev/kvm" >&2
  exit 1
fi

log "stereos ssh key"
mkdir -p ~/.config/stereos
[ -f ~/.config/stereos/ssh-key ] || ssh-keygen -t ed25519 -f ~/.config/stereos/ssh-key -N "" -q
cat ~/.config/stereos/ssh-key.pub

log "nix"
if ! command -v nix >/dev/null 2>&1; then
  # Keep the systemd init: the multi-user store needs a running nix-daemon, and
  # \`--init none\` leaves builds failing on /nix/var/nix/db/big-lock.
  curl -fsSL https://install.determinate.systems/nix \\
    | sh -s -- install linux --no-confirm --extra-conf "max-jobs = auto"
fi
export PATH=/nix/var/nix/profiles/default/bin:$PATH
nix --version

log "bun"
command -v bun >/dev/null 2>&1 || curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version

log "pnpm"
command -v pnpm >/dev/null 2>&1 || sudo npm install -g pnpm@10.15.0 >/dev/null
pnpm --version

log "stereOS source"
[ -d ~/stereOS ] || git clone --depth 1 https://github.com/papercomputeco/stereOS ~/stereOS

log "build the x86_64 coder-dev mixtape (long; ~gigabytes of Nix closure)"
cd ~/stereOS
time make build-qcow2 MIXTAPE=coder-dev ARCH=x86_64-linux

log "built"
ls -l result/ || true
`,"apps/stereos-site/real/run-on-linux-host.sh":`#!/usr/bin/env bash
# run-on-linux-host.sh \u2014 boot the locally built mixtape under QEMU/KVM and run
# the Smithers workflow against it.
#
# Run on a host already prepared by provision-linux-host.sh, from the directory
# holding stereos-real.tsx and its siblings.
#
# Unlike the macOS path this does not use masterblaster: the image was built
# from the -dev profile, which bakes ~/.config/stereos/ssh-key.pub in for both
# admin and agent, so no key injection step is needed.

set -euo pipefail

SSH_PORT="\${STEREOS_SSH_PORT:-2222}"
KEY="\${STEREOS_SSH_KEY:-$HOME/.config/stereos/ssh-key}"
IMAGE="\${STEREOS_IMAGE:-$HOME/stereOS/result/stereos.qcow2}"
BUN_VERSION="\${STEREOS_BUN_VERSION:-1.2.21}"
ALPINE_VERSION="3.24.1"
ALPINE_ROOTFS_SHA256="41f73e3cf5fa919b8aa5ca6b30dc48f0da2720776d7423e2a7748211456fe081"
ALPINE_GCC_VERSION="15.2.0-r5"
export PATH="$HOME/.bun/bin:/nix/var/nix/profiles/default/bin:$PATH"

if [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
  if [ "\${STEREOS_KVM_REEXEC:-0}" != 1 ]; then
    echo "re-entering with the kvm group so QEMU can open /dev/kvm" >&2
    exec sg kvm -c "STEREOS_KVM_REEXEC=1 bash $(printf '%q' "$0")"
  fi
  echo "current shell cannot read and write /dev/kvm; log out and back in" >&2
  exit 1
fi

ssh_guest() {
  ssh -p "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
    -o LogLevel=ERROR -o IdentitiesOnly=yes -o ConnectTimeout=5 agent@127.0.0.1 "$@"
}

if ! ssh_guest true 2>/dev/null; then
  # The Nix store image is read-only, so boot a copy-on-write overlay over it.
  OVERLAY="\${STEREOS_OVERLAY:-$HOME/stereos-overlay.qcow2}"
  [ -f "$OVERLAY" ] || qemu-img create -f qcow2 -F qcow2 -b "$IMAGE" "$OVERLAY" >/dev/null

  # Mixtape images boot through GRUB under UEFI, so the VM needs OVMF. With
  # SeaBIOS the firmware never hands off and the serial log stays empty.
  OVMF_CODE="\${STEREOS_OVMF_CODE:-/usr/share/OVMF/OVMF_CODE_4M.fd}"
  OVMF_VARS="\${STEREOS_OVMF_VARS:-$HOME/stereos-efi-vars.fd}"
  [ -f "$OVMF_VARS" ] || cp /usr/share/OVMF/OVMF_VARS_4M.fd "$OVMF_VARS"

  echo "== booting $OVERLAY under QEMU/KVM =="
  # No -nographic: it conflicts with -daemonize. -display none plus a serial
  # log file gives the same console capture for a detached VM.
  qemu-system-x86_64 \\
    -machine q35,accel=kvm -cpu host -smp 2 -m 3072 \\
    -drive "if=pflash,format=raw,unit=0,readonly=on,file=$OVMF_CODE" \\
    -drive "if=pflash,format=raw,unit=1,file=$OVMF_VARS" \\
    -drive "file=$OVERLAY,if=virtio,format=qcow2" \\
    -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$SSH_PORT-:22" \\
    -device virtio-net-pci,netdev=net0 \\
    -serial file:"$HOME/vm-console.log" -display none -daemonize
  for _ in $(seq 1 90); do
    ssh_guest true 2>/dev/null && break
    sleep 2
  done
fi

echo "== install official Bun v$BUN_VERSION in guest =="
BUN_CACHE="$HOME/.cache/stereos-bun/v$BUN_VERSION"
mkdir -p "$BUN_CACHE"
if [ ! -x "$BUN_CACHE/bun-linux-x64-musl/bun" ]; then
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-x64-musl.zip" \\
    -o "$BUN_CACHE/bun-linux-x64-musl.zip"
  unzip -oq "$BUN_CACHE/bun-linux-x64-musl.zip" -d "$BUN_CACHE"
fi
if [ ! -x "$BUN_CACHE/lib/ld-musl-x86_64.so.1" ]; then
  rootfs="$BUN_CACHE/alpine-minirootfs-$ALPINE_VERSION-x86_64.tar.gz"
  curl -fsSL "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86_64/$(basename "$rootfs")" -o "$rootfs"
  printf '%s  %s\\n' "$ALPINE_ROOTFS_SHA256" "$rootfs" | sha256sum -c -
  tar -xzf "$rootfs" -C "$BUN_CACHE" ./lib/ld-musl-x86_64.so.1
fi
if [ ! -f "$BUN_CACHE/usr/lib/libstdc++.so.6.0.34" ]; then
  for package in libstdc++ libgcc; do
    apk="$BUN_CACHE/$package-$ALPINE_GCC_VERSION.apk"
    curl -fsSL "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/$(basename "$apk")" -o "$apk"
    tar -xf "$apk" -C "$BUN_CACHE" usr/lib
  done
fi
ssh_guest 'mkdir -p /home/agent/.local/bin /home/agent/.local/lib'
scp -q -P "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/bun-linux-x64-musl/bun" \\
  agent@127.0.0.1:/home/agent/.local/bin/bun-bin
scp -q -P "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/lib/ld-musl-x86_64.so.1" \\
  agent@127.0.0.1:/home/agent/.local/lib/ld-musl-x86_64.so.1
scp -q -P "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/usr/lib/libstdc++.so.6.0.34" \\
  agent@127.0.0.1:/home/agent/.local/lib/libstdc++.so.6
scp -q -P "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
  -o LogLevel=ERROR -o IdentitiesOnly=yes "$BUN_CACHE/usr/lib/libgcc_s.so.1" \\
  agent@127.0.0.1:/home/agent/.local/lib/libgcc_s.so.1
cat <<'WRAPPER' | ssh_guest 'cat > /home/agent/.local/bin/bun && chmod 755 /home/agent/.local/bin/bun /home/agent/.local/bin/bun-bin /home/agent/.local/lib/ld-musl-x86_64.so.1'
#!/bin/sh
export LD_LIBRARY_PATH=/home/agent/.local/lib
exec /home/agent/.local/lib/ld-musl-x86_64.so.1 /home/agent/.local/bin/bun-bin "$@"
WRAPPER
ssh_guest '/home/agent/.local/bin/bun --version'

echo "== guest =="
ssh_guest 'id -un; hostname; uname -srm; grep PRETTY /etc/os-release'

echo "== smithers run =="
export STEREOS_SSH_PORT="$SSH_PORT" STEREOS_SSH_KEY="$KEY"
SMITHERS_ROOT="\${SMITHERS_ROOT:-$(git rev-parse --show-toplevel)}"
exec env -u ANTHROPIC_API_KEY bun "$SMITHERS_ROOT/apps/cli/src/index.js" \\
  up "$SMITHERS_ROOT/apps/stereos-site/real/stereos-real.tsx" \\
  --input '{"prompt":"hello from the linux host"}'
`,"apps/stereos-site/real/stereos-provider.ts":`/**
 * A real Smithers sandbox provider backed by a booted stereOS mixtape VM.
 *
 * The whole provider is the SandboxSession seam plus SSH. Everything else \u2014
 * request shipping, the env contract, result parsing, secret scrubbing,
 * cleanup \u2014 is \`createCommandSandboxProvider\` from the shipped
 * \`smthrs/sandbox\` package.
 *
 * The VM is booted and keyed by masterblaster (\`mb up\`), which injects the
 * SSH key over the stereosd vsock control plane. Point the provider at it with:
 *
 *   STEREOS_SSH_HOST  host running sshd            (default 127.0.0.1)
 *   STEREOS_SSH_PORT  forwarded guest sshd port    (default 2222)
 *   STEREOS_SSH_KEY   private key path             (default ~/.config/stereos/ssh-key)
 *   STEREOS_SSH_USER  guest user                   (default agent)
 */
import { createCommandSandboxProvider } from "smthrs/sandbox";
import type { SandboxSession } from "smthrs/sandbox";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME ?? "";

export const WORKDIR = "/home/agent/workspace";
const RUNNER_PATH = \`\${WORKDIR}/.smithers/guest-runner.sh\`;
const WORKFLOW_PATH = \`\${WORKDIR}/.smithers/child-workflow.js\`;

const SSH_HOST = process.env.STEREOS_SSH_HOST ?? "127.0.0.1";
const SSH_PORT = process.env.STEREOS_SSH_PORT ?? "2222";
const SSH_KEY = process.env.STEREOS_SSH_KEY ?? \`\${HOME}/.config/stereos/ssh-key\`;
const SSH_USER = process.env.STEREOS_SSH_USER ?? "agent";

const SSH_ARGS = [
  "-p",
  SSH_PORT,
  "-i",
  SSH_KEY,
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "ConnectTimeout=10",
  \`\${SSH_USER}@\${SSH_HOST}\`,
];

/** Single-quote a value for the guest shell. */
const q = (s: string) => \`'\${s.replace(/'/g, \`'\\\\''\`)}'\`;

async function ssh(cmd: string, stdin?: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const proc = Bun.spawn(["ssh", ...SSH_ARGS, cmd], {
    stdin: stdin === undefined ? "ignore" : (new Response(stdin).body ?? "ignore"),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let aborted = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    try {
      proc.kill("SIGTERM");
      forceTimer ??= setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // The process exited after SIGTERM.
        }
      }, 1_000);
    } catch {
      // The process may have exited between the signal and this callback.
    }
  };
  const onAbort = () => {
    aborted = true;
    kill();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs)
    : undefined;
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (aborted) throw new DOMException("stereOS SSH transport aborted", "AbortError");
    if (timedOut) throw new Error(\`stereOS SSH transport timed out after \${opts.timeoutMs} ms\`);
    return { exitCode, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

async function buildGuestWorkflow() {
  const result = await Bun.build({
    entrypoints: [join(HERE, "child-workflow.tsx")],
    target: "bun",
    format: "esm",
    minify: false,
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(\`failed to bundle the guest child workflow: \${result.logs.map(String).join("\\n")}\`);
  }
  return result.outputs[0].text();
}

/** Prove the VM answers before a run commits to it. */
export async function probeVm() {
  return ssh("id -un; uname -srm");
}

export const stereosProvider = createCommandSandboxProvider({
  id: "stereos",
  workdir: WORKDIR,
  // The host uploads this tiny launcher and a bundle of child-workflow.tsx.
  // bootstrap-vm.sh/run-on-linux-host.sh install the official static Bun build.
  command: \`sh \${RUNNER_PATH}\`,
  cleanup: "keep", // VM lifecycle stays with \`mb up\` / \`mb down\`.
  async createSession(request): Promise<SandboxSession> {
    const session: SandboxSession = {
      remoteId: \`stereos-\${request.sandboxId}\`,
      async writeFile(path, content) {
        const r = await ssh(\`mkdir -p "$(dirname \${q(path)})" && cat > \${q(path)}\`, content, {
          signal: request.signal,
          timeoutMs: 30_000,
        });
        if (r.exitCode !== 0) throw new Error(\`stereos writeFile \${path} failed: \${r.stderr.trim()}\`);
      },
      async readFile(path) {
        const r = await ssh(\`cat \${q(path)}\`, undefined, { signal: request.signal, timeoutMs: 30_000 });
        if (r.exitCode !== 0) throw new Error(\`stereos readFile \${path} failed: \${r.stderr.trim()}\`);
        return r.stdout;
      },
      async exec(command, opts) {
        const env = Object.entries(opts.env)
          .map(([k, v]) => \`\${k}=\${q(String(v))}\`)
          .join(" ");
        const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
        return ssh(\`cd \${q(opts.cwd)} && env \${env} timeout \${seconds}s sh -c \${q(command)}\`, undefined, {
          signal: opts.signal,
          timeoutMs: opts.timeoutMs + 5_000,
        });
      },
    };
    // Upload the entry runner alongside the request the kit is about to write.
    await session.writeFile(RUNNER_PATH, readFileSync(join(HERE, "guest-runner.sh"), "utf8"));
    await session.writeFile(WORKFLOW_PATH, await buildGuestWorkflow());
    return session;
  },
});
`,"apps/stereos-site/real/stereos-real.tsx":`/** @jsxImportSource smthrs */
/**
 * A Smithers run whose work happens inside a real stereOS mixtape VM.
 *
 * Boot the VM first, then run this workflow:
 *
 *   cd apps/stereos-site/real
 *   mb up                                   # boots the mixtape (~8s)
 *   eval "$(./bootstrap-vm.sh)"             # keys the agent user, exports the port
 *   env -u ANTHROPIC_API_KEY bun ../../../apps/cli/src/index.js up stereos-real.tsx \\
 *     --input '{"prompt":"hello from the host"}'
 *
 * See real/README.md for the full recipe and the recorded run.
 */
import { createSmithers, Sandbox } from "smthrs";
import { z } from "zod";
import childWorkflow, { guestResultSchema } from "./child-workflow.tsx";
import { stereosProvider } from "./stereos-provider.ts";

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({ prompt: z.string().default("hello from the host") }),
  result: guestResultSchema,
});

export default smithers((ctx) => (
  <Workflow name="stereos-real">
    <Sandbox
      id="stereos-vm"
      provider={stereosProvider}
      workflow={childWorkflow}
      input={{ prompt: ctx.input.prompt }}
      output={outputs.result}
      allowNetwork
      reviewDiffs={false}
      timeoutMs={120_000}
      retries={1}
    />
  </Workflow>
));
`,"apps/stereos-site/service/README.md":'# The stereos.smithers.sh demo service\n\nWhat runs on the GCE host `stereos-smithers-demo` (n2-standard-2, us-east1-b,\nnested virtualization) so that the Live demo tab drives real stereOS VMs.\n\nPrepare the host first with `../real/provision-linux-host.sh`, which installs\nQEMU/KVM, Nix, and Bun and builds the `coder-dev` x86_64 mixtape. Then:\n\n```sh\nCLOUDFLARE_API_TOKEN=\u2026 ./install.sh\n```\n\n## Units\n\n| Unit | What it does |\n| --- | --- |\n| `stereos-vm.service` | Boots the mixtape under QEMU/KVM through `boot-vm.sh` and keeps it up. The VM is sticky: every demo run reuses it, so a run pays SSH and guest execution only. Installs the guest Bun runtime on first boot. |\n| `stereos-gateway.service` | A Smithers gateway bound to `127.0.0.1:7331`, serving the workspace at `~/stereos-demo` where the three demo workflows live. Requires a bearer token even on loopback; the token is in `/etc/stereos-demo.env`, mode 0600, root-owned. |\n| `stereos-guard.service` | `guard.ts` on `127.0.0.1:8787`. The only thing published. Serves the bundled run UI and four API routes. |\n| `stereos-tunnel.service` | `tunnel.sh`: a cloudflared tunnel from the guard outward, so the host opens no inbound port. Publishes its own hostname to the `_stereos-api.smithers.sh` TXT record. |\n\nAll four are enabled, so the stack returns after a reboot.\n\n## The guard\n\n`guard.ts` is the security boundary. The gateway\'s full RPC surface (hijack,\nbrowser sessions, cron, arbitrary workflow launch, run diffs, host paths) is not\nreachable from the internet. The guard exposes:\n\n| Route | Effect |\n| --- | --- |\n| `GET /api/health` | Capacity and queue depth. |\n| `POST /api/runs` | Launch one of three allowlisted workflows with server-chosen input. Returns a run id and a per-run token. |\n| `GET /api/runs/:id` | A hand-built projection: status, node labels and statuses, elapsed time, and the child workflow\'s own output. |\n| `POST /api/runs/:id/approval` | Resolve the approval gate. Requires the run\'s token. |\n\nEnforced:\n\n- Only `hello`, `pipeline`, and `approval-demo` may launch, and only with input\n  the guard chooses. A workflow id from the request is never forwarded.\n- The gateway method name is never taken from a request. Six methods are\n  reachable in total, all named as literals in `guard.ts`.\n- At most two concurrent runs, with a queue of eight and a visible position.\n- Six starts per IP per ten minutes.\n- Approval requires the 256-bit token minted at start, compared with\n  `timingSafeEqual`.\n- Runs are cancelled at five minutes and their slot is freed.\n- Responses are built field by field. Engine rows are never spread into a\n  response, so workflow paths, config, and env cannot leak.\n- Non-GET requests never reach the static file handler, so a request shaped like\n  `POST /v1/rpc/<method>` is a 404 rather than an SPA response.\n\n## Discovery\n\nThe page prefers `https://stereos-api.smithers.sh`. Creating that named tunnel\nneeds a Cloudflare API token carrying `Cloudflare Tunnel: Edit`; until then\n`tunnel.sh` runs a quick tunnel and writes its current hostname to the\n`_stereos-api.smithers.sh` TXT record, which the page resolves over\nDNS-over-HTTPS. The record holds a hostname only. It grants nothing on its own,\nbecause the guard is the entire public surface.\n\nTo switch to the named tunnel, write `/etc/stereos-tunnel.json` as\n`{"token":"<tunnel token>"}` and restart `stereos-tunnel.service`.\n\n## Workflows\n\n`workflows/*.tsx` run on the host; each `<Sandbox>` body runs in the guest\nthrough `stereos-provider.ts`, which is `real/stereos-provider.ts` with the\nguest entrypoint lifted into a parameter. The guest modules are `guest-*.tsx`;\nthey share `guest-facts.ts`, which reports the values the page shows as proof of\nin-guest execution.\n\n`approval-demo` reads its own gate decision with `ctx.outputMaybe` and sets\n`skipIf` on the sandbox, so a denial runs nothing in the VM.\n\n## Latency\n\nMeasured on the reference host, 2026-08-13:\n\n| | |\n| --- | --- |\n| Cold boot to guest sshd | 25 s |\n| Cold boot to a finished run | 29 s |\n| First run after a cold boot | 4.2 s |\n| Warm run, public HTTPS to finished | 2.2 - 4.1 s |\n| Sandbox node alone | 1.9 - 2.3 s |\n',"apps/stereos-site/service/boot-vm.sh":`#!/usr/bin/env bash
# Boot the locally built coder-dev mixtape under QEMU/KVM and keep it up.
#
# stereos-vm.service runs this in the foreground: QEMU stays attached (no
# -daemonize) so systemd owns the process and restarts it if the guest dies.
# The guest runtime is installed once per boot, because the copy-on-write
# overlay is recreated only when it is missing.

set -euo pipefail

SSH_PORT="\${STEREOS_SSH_PORT:-2222}"
KEY="\${STEREOS_SSH_KEY:-$HOME/.config/stereos/ssh-key}"
IMAGE="\${STEREOS_IMAGE:-$HOME/stereOS/result/stereos.qcow2}"
OVERLAY="\${STEREOS_OVERLAY:-$HOME/stereos-overlay.qcow2}"
OVMF_CODE="\${STEREOS_OVMF_CODE:-/usr/share/OVMF/OVMF_CODE_4M.fd}"
OVMF_VARS="\${STEREOS_OVMF_VARS:-$HOME/stereos-efi-vars.fd}"
RUNTIME_DIR="\${STEREOS_RUNTIME_DIR:-$HOME/.cache/stereos-bun/v1.2.21}"

export PATH="$HOME/.bun/bin:/nix/var/nix/profiles/default/bin:$PATH"

[ -f "$OVERLAY" ] || qemu-img create -f qcow2 -F qcow2 -b "$IMAGE" "$OVERLAY" >/dev/null
[ -f "$OVMF_VARS" ] || cp /usr/share/OVMF/OVMF_VARS_4M.fd "$OVMF_VARS"

ssh_guest() {
  ssh -p "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
    -o LogLevel=ERROR -o IdentitiesOnly=yes -o ConnectTimeout=5 agent@127.0.0.1 "$@"
}

# Install the guest Bun runtime once the guest answers, then stay out of the way.
(
  for _ in $(seq 1 120); do
    if ssh_guest true 2>/dev/null; then
      if ! ssh_guest '/home/agent/.local/bin/bun --version' >/dev/null 2>&1; then
        ssh_guest 'mkdir -p /home/agent/.local/bin /home/agent/.local/lib'
        scp_guest() {
          scp -q -P "$SSH_PORT" -i "$KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
            -o LogLevel=ERROR -o IdentitiesOnly=yes "$1" "agent@127.0.0.1:$2"
        }
        scp_guest "$RUNTIME_DIR/bun-linux-x64-musl/bun" /home/agent/.local/bin/bun-bin
        scp_guest "$RUNTIME_DIR/lib/ld-musl-x86_64.so.1" /home/agent/.local/lib/ld-musl-x86_64.so.1
        scp_guest "$RUNTIME_DIR/usr/lib/libstdc++.so.6.0.34" /home/agent/.local/lib/libstdc++.so.6
        scp_guest "$RUNTIME_DIR/usr/lib/libgcc_s.so.1" /home/agent/.local/lib/libgcc_s.so.1
        printf '%s\\n' '#!/bin/sh' \\
          'export LD_LIBRARY_PATH=/home/agent/.local/lib' \\
          'exec /home/agent/.local/lib/ld-musl-x86_64.so.1 /home/agent/.local/bin/bun-bin "$@"' |
          ssh_guest 'cat > /home/agent/.local/bin/bun && chmod 755 /home/agent/.local/bin/bun /home/agent/.local/bin/bun-bin /home/agent/.local/lib/ld-musl-x86_64.so.1'
      fi
      ssh_guest '/home/agent/.local/bin/bun --version' >&2 || true
      break
    fi
    sleep 2
  done
) &

# Mixtape images boot through GRUB under UEFI, so the VM needs OVMF. With
# SeaBIOS the firmware never hands off and the serial log stays empty.
exec qemu-system-x86_64 \\
  -machine q35,accel=kvm -cpu host -smp 2 -m 3072 \\
  -drive "if=pflash,format=raw,unit=0,readonly=on,file=$OVMF_CODE" \\
  -drive "if=pflash,format=raw,unit=1,file=$OVMF_VARS" \\
  -drive "file=$OVERLAY,if=virtio,format=qcow2" \\
  -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$SSH_PORT-:22" \\
  -device virtio-net-pci,netdev=net0 \\
  -serial file:"$HOME/vm-console.log" -display none
`,"apps/stereos-site/service/build-ui.ts":`/**
 * Bundle the embedded run UI into ui/dist, which guard.ts serves as static
 * files.
 *
 * The gateway bundles workflow UIs with \`Bun.build\` for the same reason this
 * does: every \`smthrs/ui\` and \`smthrs/gateway-ui\` component is self-styled and
 * carries no \`.css\` import, so a single JS bundle plus a one-line HTML shell is
 * the whole app. Nothing is fetched from a CDN at runtime.
 *
 * Run: bun build-ui.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const here = import.meta.dir;
const outdir = join(here, "ui", "dist");

await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(here, "ui", "src", "main.jsx")],
  outdir,
  target: "browser",
  format: "esm",
  minify: true,
  naming: "[dir]/app.[ext]",
  define: { "process.env.NODE_ENV": '"production"' },
});

if (!result.success) {
  console.error(result.logs.map(String).join("\\n"));
  process.exit(1);
}

await writeFile(
  join(outdir, "index.html"),
  \`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>stereOS demo runs</title>
<style>html,body{margin:0;background:transparent}</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="./app.js"><\/script>
</body>
</html>
\`,
);

const bytes = result.outputs.reduce((sum, output) => sum + output.size, 0);
console.log(\`ui/dist: \${result.outputs.length} file(s), \${(bytes / 1024).toFixed(1)} KiB\`);
`,"apps/stereos-site/service/guard.ts":`/**
 * The public edge of the stereOS demo.
 *
 * cloudflared publishes this process and nothing else. The Smithers gateway
 * listens on loopback with a bearer token that never leaves the host, so the
 * full RPC surface (hijack, browser sessions, cron, arbitrary workflow launch,
 * run diffs) is unreachable from the internet. This file is the entire public
 * API: four routes, each of which performs one whitelisted gateway call and
 * returns a hand-built projection.
 *
 * Enforced here:
 *   - only the three demo workflow ids may launch, and only with server-chosen input
 *   - at most MAX_CONCURRENT demo runs, with a visible queue
 *   - per-IP rate limit on starts
 *   - approval decisions require the unguessable token minted at start
 *   - runs are cancelled at RUN_TIMEOUT_MS
 *   - the response projection is built field by field, never by spreading engine rows
 */
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

const GATEWAY_URL = process.env.STEREOS_GATEWAY_URL ?? "http://127.0.0.1:7331";
const GATEWAY_TOKEN = process.env.SMITHERS_API_KEY ?? "";
const PORT = Number(process.env.STEREOS_GUARD_PORT ?? 8787);
const UI_DIR = process.env.STEREOS_UI_DIR ?? join(import.meta.dir, "ui", "dist");

/**
 * The only workflows the public edge may launch, with the only input each may
 * receive and the node ids whose status the UI is allowed to see. Input is
 * chosen here, never taken from the request, so a visitor cannot steer a run.
 */
const ALLOWED = {
  hello: {
    input: () => ({ name: "stereOS" }),
    nodes: [{ id: "stereos-vm", label: "Run in the stereOS VM" }],
  },
  pipeline: {
    input: () => ({ text: "Smithers runs this inside a real VM" }),
    nodes: [
      { id: "prepare", label: "Prepare input on the host" },
      { id: "stereos-vm", label: "Compute in the stereOS VM" },
      { id: "report", label: "Summarize on the host" },
    ],
  },
  "approval-demo": {
    input: () => ({ change: "write approved-change.txt in the guest workspace" }),
    nodes: [
      { id: "gate", label: "Wait for a human decision" },
      { id: "stereos-vm", label: "Apply the change in the stereOS VM" },
    ],
  },
} as const;
type WorkflowId = keyof typeof ALLOWED;

const MAX_CONCURRENT = 2;
const MAX_QUEUE = 8;
const RUN_TIMEOUT_MS = 5 * 60_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_STARTS = 6;

/** Server-side run bookkeeping. \`token\` is never included in any projection. */
type DemoRun = {
  runId: string;
  workflow: WorkflowId;
  token: string;
  startedAtMs: number;
  clientIp: string;
  finishedAtMs?: number;
  lastStatus?: string;
};

const runs = new Map<string, DemoRun>();
const active = new Set<string>();
const queue: Array<{ ticket: string; workflow: WorkflowId; clientIp: string }> = [];
const starts = new Map<string, number[]>();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    },
  });

/**
 * The gateway methods this process is allowed to call. The guard never
 * forwards a method name supplied by a request, so the public edge can reach
 * exactly these six and nothing else.
 */
const RPC_METHODS = ["launchRun", "getRun", "getDevToolsSnapshot", "getNodeOutput", "submitApproval", "cancelRun"] as const;
type RpcMethod = (typeof RPC_METHODS)[number];

/** One whitelisted gateway RPC over loopback. Nothing here is reachable from outside. */
async function rpc<T>(method: RpcMethod, params: unknown): Promise<T> {
  const response = await fetch(\`\${GATEWAY_URL}/v1/rpc/\${method}\`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(GATEWAY_TOKEN ? { authorization: \`Bearer \${GATEWAY_TOKEN}\` } : {}),
    },
    body: JSON.stringify(params ?? {}),
    signal: AbortSignal.timeout(30_000),
  });
  const frame = (await response.json().catch(() => null)) as
    | { ok?: boolean; payload?: T; error?: { message?: string } }
    | null;
  if (!frame || frame.ok === false) {
    throw new Error(\`gateway \${method} failed: \${frame?.error?.message ?? response.status}\`);
  }
  return frame.payload as T;
}

/** Compare two secrets without leaking their common prefix through timing. */
function tokenMatches(expected: string, given: unknown) {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

/**
 * Cloudflare sets cf-connecting-ip at its edge and overwrites any value the
 * client sent, and nothing but cloudflared can reach this loopback port, so
 * that header is the one trustworthy client identity here. A client-supplied
 * x-forwarded-for is deliberately NOT used as a fallback: honouring it would
 * let a caller mint a fresh rate-limit bucket per request.
 */
function clientIpOf(request: Request) {
  return request.headers.get("cf-connecting-ip") ?? "unattributed";
}

function rateLimited(ip: string) {
  const now = Date.now();
  const recent = (starts.get(ip) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  starts.set(ip, recent);
  return recent.length >= RATE_MAX_STARTS;
}

function noteStart(ip: string) {
  starts.set(ip, [...(starts.get(ip) ?? []), Date.now()]);
}

/** Statuses the engine reports for a run that will never progress again. */
const TERMINAL = new Set(["finished", "failed", "cancelled", "canceled", "error"]);

/**
 * Build the public view of a run. Every field is copied explicitly so engine
 * internals (workflow paths, env, provider config, host filesystem) cannot
 * leak by accident.
 */
function projectRun(run: DemoRun, row: Record<string, unknown>, nodes: PublicNode[], result: unknown) {
  return {
    runId: run.runId,
    workflow: run.workflow,
    status: typeof row.status === "string" ? row.status : "unknown",
    startedAtMs: run.startedAtMs,
    elapsedMs: (run.finishedAtMs ?? Date.now()) - run.startedAtMs,
    nodes,
    result,
  };
}

type PublicNode = { id: string; label: string; status: string };

/**
 * One node's public status, derived from whether the engine has stored its
 * output yet. The devtools snapshot carries the node tree but no per-node
 * status, so the output row is the authoritative signal.
 */
async function nodeStatus(runId: string, nodeId: string, runStatus: string): Promise<string> {
  try {
    const row = await rpc<{ status?: string }>("getNodeOutput", { runId, nodeId, iteration: 0 });
    if (row?.status === "produced") return "ok";
    if (row?.status === "failed" || row?.status === "error") return "failed";
  } catch {
    // No output row yet: the node has not produced.
  }
  if (runStatus === "waiting-approval") return nodeId === "gate" ? "waiting" : "pending";
  if (runStatus === "running") return "running";
  if (TERMINAL.has(runStatus) && runStatus !== "finished") return "cancelled";
  return "pending";
}

/**
 * The guest evidence a demo run produced. Only the child workflow's own output
 * row is forwarded, and only after it has been re-parsed from JSON, so nothing
 * the engine attached alongside it (workflow paths, config, schema) travels
 * with it.
 */
async function resultOf(runId: string): Promise<unknown> {
  try {
    const output = await rpc<{ status?: string; row?: unknown }>("getNodeOutput", {
      runId,
      nodeId: "stereos-vm",
      iteration: 0,
    });
    if (output?.status !== "produced") return null;
    return JSON.parse(JSON.stringify(output.row ?? null));
  } catch {
    return null;
  }
}

/** Cancel runs that outlive the hard timeout, then free their slot. */
async function reap() {
  const now = Date.now();
  for (const runId of [...active]) {
    const run = runs.get(runId);
    if (!run) {
      active.delete(runId);
      continue;
    }
    let status = run.lastStatus ?? "running";
    try {
      const row = await rpc<Record<string, unknown>>("getRun", { runId });
      status = typeof row.status === "string" ? row.status : status;
      run.lastStatus = status;
    } catch {
      // The gateway is briefly unavailable; keep the slot and retry next tick.
    }
    const expired = now - run.startedAtMs > RUN_TIMEOUT_MS;
    if (expired && !TERMINAL.has(status)) {
      await rpc("cancelRun", { runId }).catch(() => {});
      run.lastStatus = "cancelled";
      status = "cancelled";
    }
    // waiting-approval holds its slot: the visitor is mid-interaction.
    if (TERMINAL.has(status) || (expired && status === "waiting-approval")) {
      run.finishedAtMs ??= now;
      active.delete(runId);
    }
  }
  // Drop bookkeeping for runs nobody is polling any more.
  for (const [runId, run] of runs) {
    if (run.finishedAtMs && now - run.finishedAtMs > 30 * 60_000) runs.delete(runId);
  }
  await drain();
}

/** Promote queued tickets into real launches as slots free up. */
async function drain() {
  while (active.size < MAX_CONCURRENT && queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const pending = tickets.get(next.ticket);
    if (!pending) continue;
    try {
      const launched = await launch(next.workflow, next.clientIp);
      pending.resolve(launched);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    tickets.delete(next.ticket);
  }
}

const tickets = new Map<string, { resolve: (v: DemoRun) => void; reject: (e: Error) => void }>();

/** Launch one allowlisted workflow and take a concurrency slot. */
async function launch(workflow: WorkflowId, clientIp: string): Promise<DemoRun> {
  const response = await rpc<{ runId: string }>("launchRun", {
    workflow,
    input: ALLOWED[workflow].input(),
    options: { startedBy: { harness: "stereos-site-demo" } },
  });
  const run: DemoRun = {
    runId: response.runId,
    workflow,
    // 256 bits from the CSPRNG. The only authority over this run's approval.
    token: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""),
    startedAtMs: Date.now(),
    clientIp,
  };
  runs.set(run.runId, run);
  active.add(run.runId);
  return run;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

/** Serve the built UI. Paths are resolved inside UI_DIR and never above it. */
async function serveUi(pathname: string) {
  // Decode first: an escaped traversal such as %2e%2e must be rejected by the
  // same check as a literal one.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("not found", { status: 404 });
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\\/+/, "");
  if (relative.includes("..") || relative.includes("\\0") || relative.startsWith("/")) {
    return new Response("not found", { status: 404 });
  }
  const file = Bun.file(join(UI_DIR, relative));
  if (await file.exists()) {
    const dot = relative.lastIndexOf(".");
    return new Response(file, {
      headers: {
        "content-type": MIME[relative.slice(dot)] ?? "application/octet-stream",
        "cache-control": relative === "index.html" ? "no-store" : "public, max-age=300",
      },
    });
  }
  const index = Bun.file(join(UI_DIR, "index.html"));
  if (await index.exists()) return new Response(index, { headers: { "content-type": MIME[".html"] } });
  return new Response("not found", { status: 404 });
}

setInterval(() => {
  reap().catch(() => {});
}, 2_000);

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") return json({}, 204);

    if (path === "/api/health") {
      return json({
        ok: true,
        workflows: Object.keys(ALLOWED),
        active: active.size,
        capacity: MAX_CONCURRENT,
        queued: queue.length,
      });
    }

    if (path === "/api/runs" && request.method === "POST") {
      const ip = clientIpOf(request);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const workflow = (body as { workflow?: unknown })?.workflow;
      if (typeof workflow !== "string" || !(workflow in ALLOWED)) {
        return json({ error: "unknown workflow", allowed: Object.keys(ALLOWED) }, 400);
      }
      if (rateLimited(ip)) return json({ error: "rate limited: 6 runs per 10 minutes" }, 429);
      if (active.size >= MAX_CONCURRENT && queue.length >= MAX_QUEUE) {
        return json({ error: "the demo queue is full; try again shortly" }, 503);
      }
      noteStart(ip);
      const id = workflow as WorkflowId;
      try {
        if (active.size < MAX_CONCURRENT) {
          const run = await launch(id, ip);
          return json({ runId: run.runId, token: run.token, workflow: id, queuePosition: 0 });
        }
        const ticket = crypto.randomUUID();
        const position = queue.length + 1;
        const waited = new Promise<DemoRun>((resolve, reject) => {
          tickets.set(ticket, { resolve, reject });
          queue.push({ ticket, workflow: id, clientIp: ip });
          setTimeout(() => {
            if (tickets.delete(ticket)) reject(new Error("timed out waiting for a demo slot"));
          }, 90_000);
        });
        const run = await waited;
        return json({ runId: run.runId, token: run.token, workflow: id, queuePosition: position });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "failed to start the run" }, 502);
      }
    }

    const runMatch = path.match(/^\\/api\\/runs\\/([0-9a-fA-F-]{36})$/);
    if (runMatch && request.method === "GET") {
      const run = runs.get(runMatch[1]!);
      if (!run) return json({ error: "unknown run" }, 404);
      try {
        const row = await rpc<Record<string, unknown>>("getRun", { runId: run.runId });
        const status = typeof row.status === "string" ? row.status : (run.lastStatus ?? "unknown");
        run.lastStatus = status;
        if (TERMINAL.has(status)) run.finishedAtMs ??= Date.now();
        const nodes = await Promise.all(
          ALLOWED[run.workflow].nodes.map(async (node) => ({
            id: node.id,
            label: node.label,
            status: await nodeStatus(run.runId, node.id, status),
          })),
        );
        const result = status === "finished" ? await resultOf(run.runId) : null;
        return json(projectRun(run, row, nodes, result));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "failed to read the run" }, 502);
      }
    }

    const approveMatch = path.match(/^\\/api\\/runs\\/([0-9a-fA-F-]{36})\\/approval$/);
    if (approveMatch && request.method === "POST") {
      const run = runs.get(approveMatch[1]!);
      if (!run) return json({ error: "unknown run" }, 404);
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const { token, approved } = (body ?? {}) as { token?: unknown; approved?: unknown };
      if (!tokenMatches(run.token, token)) return json({ error: "invalid run token" }, 403);
      if (run.workflow !== "approval-demo") return json({ error: "this run has no approval gate" }, 400);
      try {
        await rpc("submitApproval", {
          runId: run.runId,
          nodeId: "gate",
          approved: approved === true,
          decision: { approved: approved === true, note: "decided from stereos.smithers.sh" },
        });
        return json({ ok: true, approved: approved === true });
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "failed to submit the decision" }, 502);
      }
    }

    // Everything that is not one of the four routes above is a static asset
    // request. Only GET/HEAD reach the UI, so a POST to a gateway-shaped path
    // such as /v1/rpc/<method> is rejected rather than answered by the SPA
    // fallback, which would read like a passthrough.
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "not found" }, 404);
    if (path.startsWith("/api/") || path.startsWith("/v1/")) return json({ error: "not found" }, 404);
    return serveUi(path);
  },
});

console.log(\`stereos guard listening on 127.0.0.1:\${PORT}, gateway \${GATEWAY_URL}, ui \${UI_DIR}\`);
`,"apps/stereos-site/service/guest-apply.tsx":`/** @jsxImportSource smthrs */
/**
 * The post-approval stage of \`approval-demo\`, executed inside the stereOS guest.
 *
 * The Approval gate itself is a host concern: the engine parks the run until a
 * decision arrives. Only the work the decision authorizes runs in the VM, so
 * the guest facts in the result are proof that the approved side effect
 * happened in the guest.
 */
import { createSmithers } from "smthrs";
import { z } from "zod";
import { guestFacts, guestFactsSchema } from "./guest-facts.ts";

export const applyResultSchema = z.object({
  status: z.string(),
  change: z.string(),
  appliedAt: z.string(),
  witness: z.string(),
  guest: guestFactsSchema,
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ change: z.string(), approved: z.boolean() }),
  result: applyResultSchema,
});

/** The child-workflow body. This function executes only in-guest. */
export async function executeGuestWork(change: string, approved: boolean) {
  const guest = await guestFacts();
  // The approved side effect is a real file write inside the guest workspace,
  // read back so the result reports what the guest filesystem actually holds.
  const path = \`\${process.env.HOME ?? "/home/agent"}/workspace/approved-change.txt\`;
  let witness = "not written (denied)";
  if (approved) {
    const line = \`\${change} @ \${guest.hostname}\`;
    await Bun.write(path, \`\${line}\\n\`);
    witness = (await Bun.file(path).text()).trim();
  }
  return {
    status: approved ? "applied" : "skipped",
    change,
    appliedAt: new Date().toISOString(),
    witness,
    guest,
  };
}

export default smithers((ctx) => (
  <Workflow name="apply-guest">
    <Task id="apply" output={outputs.result}>
      {() => executeGuestWork(ctx.input.change, ctx.input.approved)}
    </Task>
  </Workflow>
));

if (import.meta.main) {
  const requestPath = process.env.SMITHERS_SANDBOX_REQUEST_PATH;
  const resultPath = process.env.SMITHERS_SANDBOX_RESULT_PATH;
  if (!requestPath || !resultPath) throw new Error("Smithers sandbox protocol paths are unset");
  const request = await Bun.file(requestPath).json();
  const output = await executeGuestWork(
    z.string().parse(request.input?.change),
    z.boolean().parse(request.input?.approved),
  );
  const result = JSON.stringify({ status: "finished", output });
  await Bun.write(resultPath, result);
  process.stdout.write(\`\${result}\\n\`);
}
`,"apps/stereos-site/service/guest-facts.ts":`/**
 * Facts only the guest can report, collected inside the stereOS VM.
 *
 * Every demo child workflow returns this block. The page renders it as the
 * evidence that the body ran in the VM and not on the host: the host is Debian
 * on GCE, the guest is stereOS with the \`coder-dev\` hostname and a NixOS store.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export const guestFactsSchema = z.object({
  os: z.string(),
  kernel: z.string(),
  user: z.string(),
  hostname: z.string(),
  arch: z.string(),
  bun: z.string(),
  cpus: z.number(),
  memTotalKb: z.number(),
  uptimeSeconds: z.number(),
  nixStorePresent: z.boolean(),
  writeOutsideWorkspace: z.string(),
});

export type GuestFacts = z.infer<typeof guestFactsSchema>;

function command(...argv: string[]) {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return "";
  return result.stdout.toString().trim();
}

function osName() {
  try {
    const fields = Object.fromEntries(
      readFileSync("/etc/os-release", "utf8")
        .split("\\n")
        .filter((line: string) => line.includes("="))
        .map((line: string) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1).replace(/^['"]|['"]$/g, "")];
        }),
    );
    return \`\${fields.NAME ?? "unknown"} \${fields.VERSION ?? ""}\`.trim();
  } catch {
    return "unknown";
  }
}

/** Probe the restriction model: the agent user must not write outside its workspace. */
async function canWriteOutsideWorkspace() {
  try {
    await Bun.write("/etc/stereos-write-probe", "stereOS write probe\\n");
    return "ALLOWED (unexpected)";
  } catch {
    return "denied";
  }
}

/** Collect the guest-only facts. Runs inside the VM, never on the host. */
export async function guestFacts(): Promise<GuestFacts> {
  return {
    os: osName(),
    kernel: command("uname", "-srm"),
    user: command("id", "-un"),
    hostname: command("hostname"),
    arch: process.arch,
    bun: Bun.version,
    cpus: Number(command("nproc")) || 0,
    memTotalKb: Number(command("sh", "-c", "awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null")) || 0,
    uptimeSeconds: Math.round(Number(command("sh", "-c", "cut -d' ' -f1 /proc/uptime 2>/dev/null")) || 0),
    nixStorePresent: existsSync("/nix/store"),
    writeOutsideWorkspace: await canWriteOutsideWorkspace(),
  };
}
`,"apps/stereos-site/service/guest-hello.tsx":`/** @jsxImportSource smthrs */
/**
 * \`hello\`, executed inside the stereOS guest.
 *
 * The provider bundles this module on the host, uploads the bundle over SSH,
 * and the guest's Bun binary runs it. The greeting string is built in the VM.
 */
import { createSmithers } from "smthrs";
import { z } from "zod";
import { guestFacts, guestFactsSchema } from "./guest-facts.ts";

export const helloResultSchema = z.object({
  message: z.string(),
  guest: guestFactsSchema,
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ name: z.string() }),
  result: helloResultSchema,
});

/** The child-workflow body. This function executes only in-guest. */
export async function executeGuestWork(name: string) {
  const guest = await guestFacts();
  return { message: \`Hello, \${name} - from \${guest.user}@\${guest.hostname} on \${guest.kernel}\`, guest };
}

export default smithers((ctx) => (
  <Workflow name="hello-guest">
    <Task id="greet" output={outputs.result}>
      {() => executeGuestWork(ctx.input.name)}
    </Task>
  </Workflow>
));

// createCommandSandboxProvider writes the request path into the environment.
// Bun runs this bundled module as the guest entrypoint and this branch writes
// the provider result. Importing the module on the host does not enter it.
if (import.meta.main) {
  const requestPath = process.env.SMITHERS_SANDBOX_REQUEST_PATH;
  const resultPath = process.env.SMITHERS_SANDBOX_RESULT_PATH;
  if (!requestPath || !resultPath) throw new Error("Smithers sandbox protocol paths are unset");
  const request = await Bun.file(requestPath).json();
  const output = await executeGuestWork(z.string().parse(request.input?.name));
  const result = JSON.stringify({ status: "finished", output });
  await Bun.write(resultPath, result);
  process.stdout.write(\`\${result}\\n\`);
}
`,"apps/stereos-site/service/guest-pipeline.tsx":`/** @jsxImportSource smthrs */
/**
 * \`pipeline\`, executed inside the stereOS guest.
 *
 * Three dependent stages run in the VM: normalize the input text, count its
 * words, then compute a prime sieve whose upper bound is derived from the
 * input, so the reported numbers change with the input the visitor sends.
 */
import { createSmithers } from "smthrs";
import { z } from "zod";
import { guestFacts, guestFactsSchema } from "./guest-facts.ts";

export const pipelineResultSchema = z.object({
  normalized: z.string(),
  words: z.number(),
  report: z.string(),
  computation: z.object({
    upperBound: z.number(),
    primeCount: z.number(),
    primeSum: z.number(),
    lastPrime: z.number(),
  }),
  guest: guestFactsSchema,
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ text: z.string() }),
  result: pipelineResultSchema,
});

function primesThrough(upperBound: number) {
  const composite = new Uint8Array(upperBound + 1);
  let primeCount = 0;
  let primeSum = 0;
  let lastPrime = 0;
  for (let candidate = 2; candidate <= upperBound; candidate += 1) {
    if (composite[candidate]) continue;
    primeCount += 1;
    primeSum += candidate;
    lastPrime = candidate;
    if (candidate * candidate <= upperBound) {
      for (let multiple = candidate * candidate; multiple <= upperBound; multiple += candidate) {
        composite[multiple] = 1;
      }
    }
  }
  return { upperBound, primeCount, primeSum, lastPrime };
}

/** The child-workflow body. This function executes only in-guest. */
export async function executeGuestWork(text: string) {
  const normalized = text.trim().toLowerCase();
  const words = normalized.split(/\\s+/).filter(Boolean).length;
  const bytes = new TextEncoder().encode(normalized);
  const upperBound = 20_000 + (bytes.reduce((sum, byte) => sum + byte, 0) % 5_000);
  const computation = primesThrough(upperBound);
  const guest = await guestFacts();
  return {
    normalized,
    words,
    report: \`\${words} word(s), \${computation.primeCount} primes below \${upperBound}, computed on \${guest.hostname}\`,
    computation,
    guest,
  };
}

export default smithers((ctx) => (
  <Workflow name="pipeline-guest">
    <Task id="compute" output={outputs.result}>
      {() => executeGuestWork(ctx.input.text)}
    </Task>
  </Workflow>
));

if (import.meta.main) {
  const requestPath = process.env.SMITHERS_SANDBOX_REQUEST_PATH;
  const resultPath = process.env.SMITHERS_SANDBOX_RESULT_PATH;
  if (!requestPath || !resultPath) throw new Error("Smithers sandbox protocol paths are unset");
  const request = await Bun.file(requestPath).json();
  const output = await executeGuestWork(z.string().parse(request.input?.text));
  const result = JSON.stringify({ status: "finished", output });
  await Bun.write(resultPath, result);
  process.stdout.write(\`\${result}\\n\`);
}
`,"apps/stereos-site/service/guest-runner.sh":`#!/bin/sh
# Execute the bundled child workflow with the Bun binary that
# install-guest-runtime.sh copied into the guest.
#
# The launcher constructs no results. It checks the two paths and execs Bun,
# which reads SMITHERS_SANDBOX_REQUEST_PATH and writes
# SMITHERS_SANDBOX_RESULT_PATH itself.

set -eu

BUN_PATH="\${STEREOS_GUEST_BUN:-/home/agent/.local/bin/bun}"
WORKFLOW_PATH="\${STEREOS_GUEST_WORKFLOW:-$(dirname "$0")/child-workflow.js}"

[ -x "$BUN_PATH" ] || { echo "guest Bun is missing or not executable: $BUN_PATH" >&2; exit 127; }
[ -r "$WORKFLOW_PATH" ] || { echo "guest child workflow is missing: $WORKFLOW_PATH" >&2; exit 127; }

exec "$BUN_PATH" "$WORKFLOW_PATH"
`,"apps/stereos-site/service/install.sh":`#!/usr/bin/env bash
# Install the stereos.smithers.sh demo service on a host already prepared by
# real/provision-linux-host.sh (QEMU/KVM, Nix, Bun, the built coder-dev image).
#
#   ./install.sh                 install units, reload systemd, start everything
#   ./install.sh --no-start      lay the files down without touching services
#
# Layout it creates:
#   ~/stereos-demo/.smithers/    the demo workspace: workflows + provider + guard
#   ~/stereos-demo/node_modules  symlink to the checkout, so \`smthrs\` resolves
#   /etc/stereos-demo.env        0600: the gateway bearer token
#   /etc/systemd/system/         stereos-vm, stereos-gateway, stereos-guard

set -euo pipefail

HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="\${STEREOS_WORKSPACE:-$HOME/stereos-demo}"
CHECKOUT="\${STEREOS_CHECKOUT:-$HOME/smithers}"
ENV_FILE=/etc/stereos-demo.env
LIB_DIR=/usr/local/lib/stereos-demo
START=1
[ "\${1:-}" = "--no-start" ] && START=0

[ -d "$CHECKOUT/node_modules" ] || { echo "no node_modules in $CHECKOUT; run pnpm install there first" >&2; exit 1; }

echo "== laying down $WORKSPACE =="
rm -rf "$WORKSPACE/.smithers"
mkdir -p "$WORKSPACE/.smithers"
tar -C "$HERE" --exclude systemd -cf - . | tar -C "$WORKSPACE/.smithers" -xf -
ln -sfn "$CHECKOUT/node_modules" "$WORKSPACE/node_modules"
chmod +x "$WORKSPACE/.smithers/guest-runner.sh" "$WORKSPACE/.smithers/boot-vm.sh"

echo "== bundling the embedded run UI =="
(cd "$WORKSPACE/.smithers" && bun build-ui.ts)

echo "== $LIB_DIR =="
sudo mkdir -p "$LIB_DIR"
sudo install -m 0755 "$HERE/boot-vm.sh" "$LIB_DIR/boot-vm.sh"
sudo install -m 0755 "$HERE/tunnel.sh" "$LIB_DIR/tunnel.sh"

if [ ! -f "$ENV_FILE" ]; then
  echo "== minting the gateway bearer token =="
  printf 'SMITHERS_API_KEY=%s\\n' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n')" | sudo tee "$ENV_FILE" >/dev/null
fi
# The tunnel unit publishes its own hostname, so it needs a DNS-scoped token.
# Pass it in the environment on first install; it is stored 0600 root-only.
if [ -n "\${CLOUDFLARE_API_TOKEN:-}" ] && ! sudo grep -q CLOUDFLARE_API_TOKEN "$ENV_FILE"; then
  printf 'CLOUDFLARE_API_TOKEN=%s\\n' "$CLOUDFLARE_API_TOKEN" | sudo tee -a "$ENV_FILE" >/dev/null
fi
sudo chmod 0600 "$ENV_FILE"
sudo chown root:root "$ENV_FILE"

echo "== systemd units =="
for unit in stereos-vm stereos-gateway stereos-guard stereos-tunnel; do
  sed -e "s|@USER@|$USER|g" -e "s|@HOME@|$HOME|g" -e "s|@WORKSPACE@|$WORKSPACE|g" -e "s|@CHECKOUT@|$CHECKOUT|g" \\
    "$HERE/systemd/$unit.service" | sudo tee "/etc/systemd/system/$unit.service" >/dev/null
done
sudo systemctl daemon-reload

if [ "$START" = 1 ]; then
  echo "== starting =="
  sudo systemctl enable --now stereos-vm.service
  sudo systemctl enable --now stereos-gateway.service
  sudo systemctl enable --now stereos-guard.service
  sudo systemctl enable --now stereos-tunnel.service
  sleep 5
  systemctl --no-pager --lines=0 status stereos-vm stereos-gateway stereos-guard stereos-tunnel || true
fi

echo "done. guard on 127.0.0.1:\${STEREOS_GUARD_PORT:-8787}"
`,"apps/stereos-site/service/stereos-provider.ts":`/**
 * The sandbox provider the demo service uses, one instance per demo workflow.
 *
 * This is \`real/stereos-provider.ts\` with the guest entrypoint lifted into a
 * parameter so the three demo workflows can each ship their own child workflow
 * through the same SSH transport. Everything else - request shipping, the env
 * contract, result parsing, secret scrubbing, cleanup - is
 * \`createCommandSandboxProvider\` from the shipped \`smthrs/sandbox\` package.
 *
 * The VM is booted once by stereos-vm.service and reused by every run, so a
 * demo run pays SSH setup and guest execution only, not a kernel boot.
 *
 *   STEREOS_SSH_HOST  host running sshd            (default 127.0.0.1)
 *   STEREOS_SSH_PORT  forwarded guest sshd port    (default 2222)
 *   STEREOS_SSH_KEY   private key path             (default ~/.config/stereos/ssh-key)
 *   STEREOS_SSH_USER  guest user                   (default agent)
 */
import { createCommandSandboxProvider } from "smthrs/sandbox";
import type { SandboxSession } from "smthrs/sandbox";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME ?? "";

export const WORKDIR = "/home/agent/workspace";

const SSH_HOST = process.env.STEREOS_SSH_HOST ?? "127.0.0.1";
const SSH_PORT = process.env.STEREOS_SSH_PORT ?? "2222";
const SSH_KEY = process.env.STEREOS_SSH_KEY ?? \`\${HOME}/.config/stereos/ssh-key\`;
const SSH_USER = process.env.STEREOS_SSH_USER ?? "agent";

const SSH_ARGS = [
  "-p",
  SSH_PORT,
  "-i",
  SSH_KEY,
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "ConnectTimeout=10",
  \`\${SSH_USER}@\${SSH_HOST}\`,
];

/** Single-quote a value for the guest shell. */
const q = (s: string) => \`'\${s.replace(/'/g, \`'\\\\''\`)}'\`;

async function ssh(cmd: string, stdin?: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const proc = Bun.spawn(["ssh", ...SSH_ARGS, cmd], {
    stdin: stdin === undefined ? "ignore" : (new Response(stdin).body ?? "ignore"),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let aborted = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    try {
      proc.kill("SIGTERM");
      forceTimer ??= setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // The process exited after SIGTERM.
        }
      }, 1_000);
    } catch {
      // The process may have exited between the signal and this callback.
    }
  };
  const onAbort = () => {
    aborted = true;
    kill();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeoutMs)
    : undefined;
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (aborted) throw new DOMException("stereOS SSH transport aborted", "AbortError");
    if (timedOut) throw new Error(\`stereOS SSH transport timed out after \${opts.timeoutMs} ms\`);
    return { exitCode, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Prove the VM answers before a run commits to it. */
export async function probeVm() {
  return ssh("id -un; uname -srm", undefined, { timeoutMs: 15_000 });
}

async function buildGuestWorkflow(entry: string) {
  const result = await Bun.build({
    entrypoints: [join(HERE, entry)],
    target: "bun",
    format: "esm",
    minify: false,
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(\`failed to bundle \${entry}: \${result.logs.map(String).join("\\n")}\`);
  }
  return result.outputs[0].text();
}

/**
 * Build a provider that ships \`guestEntry\` into the booted stereOS guest and
 * runs it there with the guest's Bun binary.
 *
 * @param id Provider id, also the per-workflow guest directory name.
 * @param guestEntry Path to the child workflow module, relative to this file.
 */
export function createStereosProvider({ id, guestEntry }: { id: string; guestEntry: string }) {
  const guestDir = \`\${WORKDIR}/.smithers/\${id}\`;
  const runnerPath = \`\${guestDir}/guest-runner.sh\`;
  const workflowPath = \`\${guestDir}/child-workflow.js\`;
  return createCommandSandboxProvider({
    id: \`stereos-\${id}\`,
    workdir: WORKDIR,
    command: \`sh \${runnerPath}\`,
    cleanup: "keep", // The VM outlives the run; stereos-vm.service owns it.
    async createSession(request): Promise<SandboxSession> {
      const session: SandboxSession = {
        remoteId: \`stereos-\${request.sandboxId}\`,
        async writeFile(path, content) {
          const r = await ssh(\`mkdir -p "$(dirname \${q(path)})" && cat > \${q(path)}\`, content, {
            signal: request.signal,
            timeoutMs: 30_000,
          });
          if (r.exitCode !== 0) throw new Error(\`stereos writeFile \${path} failed: \${r.stderr.trim()}\`);
        },
        async readFile(path) {
          const r = await ssh(\`cat \${q(path)}\`, undefined, { signal: request.signal, timeoutMs: 30_000 });
          if (r.exitCode !== 0) throw new Error(\`stereos readFile \${path} failed: \${r.stderr.trim()}\`);
          return r.stdout;
        },
        async exec(command, opts) {
          const env = Object.entries(opts.env)
            .map(([k, v]) => \`\${k}=\${q(String(v))}\`)
            .join(" ");
          const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
          return ssh(\`cd \${q(opts.cwd)} && env \${env} timeout \${seconds}s sh -c \${q(command)}\`, undefined, {
            signal: opts.signal,
            timeoutMs: opts.timeoutMs + 5_000,
          });
        },
      };
      await session.writeFile(runnerPath, readFileSync(join(HERE, "guest-runner.sh"), "utf8"));
      await session.writeFile(workflowPath, await buildGuestWorkflow(guestEntry));
      return session;
    },
  });
}
`,"apps/stereos-site/service/systemd/stereos-gateway.service":`[Unit]
Description=Smithers gateway for the stereos.smithers.sh demo (loopback only)
After=network-online.target stereos-vm.service
Wants=network-online.target

[Service]
Type=simple
User=@USER@
WorkingDirectory=@WORKSPACE@
# The bearer token lives in a 0600 root-owned file and never reaches a client.
EnvironmentFile=/etc/stereos-demo.env
Environment=PATH=@HOME@/.bun/bin:/nix/var/nix/profiles/default/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=STEREOS_SSH_PORT=2222
Environment=STEREOS_SSH_KEY=@HOME@/.config/stereos/ssh-key
# The host runs Bun, so the default bun:sqlite backend applies. The demo
# workflows use the synchronous createSmithers() factory, which requires it.
Environment=SMITHERS_BACKEND=sqlite
# --host defaults to 127.0.0.1: the gateway is never bound to a public address.
# The token is required even on loopback, so a local process cannot drive it
# without reading the root-owned env file.
ExecStart=@HOME@/.bun/bin/bun @CHECKOUT@/apps/cli/src/index.js gateway --port 7331 --host 127.0.0.1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`,"apps/stereos-site/service/systemd/stereos-guard.service":`[Unit]
Description=Public guard and UI for the stereos.smithers.sh demo
After=network-online.target stereos-gateway.service
Wants=network-online.target

[Service]
Type=simple
User=@USER@
WorkingDirectory=@WORKSPACE@/.smithers
EnvironmentFile=/etc/stereos-demo.env
Environment=PATH=@HOME@/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=STEREOS_GATEWAY_URL=http://127.0.0.1:7331
Environment=STEREOS_GUARD_PORT=8787
ExecStart=@HOME@/.bun/bin/bun @WORKSPACE@/.smithers/guard.ts
Restart=always
RestartSec=5
# The guard holds no credentials of its own beyond the gateway token and never
# writes to the filesystem.
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=yes
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
`,"apps/stereos-site/service/systemd/stereos-tunnel.service":`[Unit]
Description=cloudflared tunnel publishing the stereos.smithers.sh demo guard
After=network-online.target stereos-guard.service
Wants=network-online.target

[Service]
Type=simple
User=@USER@
# Holds CLOUDFLARE_API_TOKEN so the unit can publish its own hostname.
EnvironmentFile=/etc/stereos-demo.env
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=STEREOS_GUARD_URL=http://127.0.0.1:8787
ExecStart=/usr/local/lib/stereos-demo/tunnel.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`,"apps/stereos-site/service/systemd/stereos-vm.service":`[Unit]
Description=stereOS coder-dev mixtape VM (QEMU/KVM) for the stereos.smithers.sh demo
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=@USER@
# QEMU needs /dev/kvm; the demo user is in the kvm group from provisioning.
SupplementaryGroups=kvm
Environment=HOME=@HOME@
Environment=PATH=@HOME@/.bun/bin:/nix/var/nix/profiles/default/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=STEREOS_SSH_PORT=2222
Environment=STEREOS_SSH_KEY=@HOME@/.config/stereos/ssh-key
ExecStart=/usr/local/lib/stereos-demo/boot-vm.sh
Restart=always
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
`,"apps/stereos-site/service/tunnel.sh":`#!/usr/bin/env bash
# Publish the guard through a cloudflared tunnel and record the resulting
# hostname in DNS, so the page can find the backend without an open port.
#
# Two modes, chosen by whether a named tunnel is configured:
#
#   named  /etc/stereos-tunnel.json exists (created by install-tunnel.sh once
#          the Cloudflare API token carries "Cloudflare Tunnel: Edit"). The
#          hostname is stable: stereos-api.smithers.sh.
#   quick  otherwise. cloudflared allocates a *.trycloudflare.com hostname at
#          startup. This script reads it out of the log and writes it to the
#          TXT record _stereos-api.smithers.sh, which the page resolves over
#          DNS-over-HTTPS to find the current backend.
#
# Either way the box never listens on a public port: cloudflared dials out.

set -euo pipefail

GUARD_URL="\${STEREOS_GUARD_URL:-http://127.0.0.1:8787}"
ZONE_ID="\${CLOUDFLARE_ZONE_ID:-8ebd98d2f0dc7d8db2e61f31ebc19c14}"
RECORD="\${STEREOS_DISCOVERY_RECORD:-_stereos-api.smithers.sh}"
LOG=/tmp/stereos-tunnel.log
NAMED_CONFIG=/etc/stereos-tunnel.json

if [ -f "$NAMED_CONFIG" ]; then
  exec cloudflared tunnel --no-autoupdate run --token "$(python3 -c 'import json;print(json.load(open("'"$NAMED_CONFIG"'"))["token"])')"
fi

: >"$LOG"
cloudflared tunnel --url "$GUARD_URL" --no-autoupdate >"$LOG" 2>&1 &
CHILD=$!
trap 'kill "$CHILD" 2>/dev/null || true' EXIT TERM INT

# cloudflared prints the assigned hostname within a few seconds of startup.
HOSTNAME=""
for _ in $(seq 1 60); do
  HOSTNAME=$(grep -oE 'https://[a-z0-9-]+\\.trycloudflare\\.com' "$LOG" | head -1 || true)
  [ -n "$HOSTNAME" ] && break
  sleep 1
done

if [ -z "$HOSTNAME" ]; then
  echo "cloudflared did not report a hostname; see $LOG" >&2
  wait "$CHILD"
  exit 1
fi

HOSTNAME="\${HOSTNAME#https://}"
echo "tunnel hostname: $HOSTNAME"

# Publish it, so the page can discover the current backend. The record holds a
# hostname only: no token, no key, nothing that grants access on its own.
if [ -n "\${CLOUDFLARE_API_TOKEN:-}" ]; then
  API="https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records"
  EXISTING=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API?type=TXT&name=$RECORD" |
    python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "")')
  BODY=$(printf '{"type":"TXT","name":"%s","content":"%s","ttl":60}' "$RECORD" "$HOSTNAME")
  if [ -n "$EXISTING" ]; then
    curl -fsS -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \\
      "$API/$EXISTING" -d "$BODY" >/dev/null && echo "updated TXT $RECORD"
  else
    curl -fsS -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \\
      "$API" -d "$BODY" >/dev/null && echo "created TXT $RECORD"
  fi
else
  echo "CLOUDFLARE_API_TOKEN unset; skipping DNS publication" >&2
fi

wait "$CHILD"
`,"apps/stereos-site/service/ui/index.html":`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>stereOS demo runs</title>
    <style>
      html, body { margin: 0; background: transparent; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"><\/script>
  </body>
</html>
`,"apps/stereos-site/service/ui/src/App.jsx":`import { useCallback, useEffect, useRef, useState } from "react";
import { StatusPill, WorkflowUiShell } from "smthrs/gateway-ui";
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, KpiStat, StageStrip } from "smthrs/ui";

/**
 * The run surface embedded in the Live demo tab of stereos.smithers.sh.
 *
 * Every value on screen comes from the guard's projection of engine state.
 * Nothing is simulated: a status is the status the engine recorded, and the
 * Approve button posts a real decision that unblocks a parked run.
 *
 * The page hosting the iframe can drive it with postMessage
 * ({ type: "stereos-start", workflow }) and receives
 * { type: "stereos-state", ... } back, so the page-side buttons and this app
 * stay in sync.
 */

const WORKFLOWS = [
  { id: "hello", label: "hello", note: "One sandbox, one greeting built in the guest." },
  { id: "pipeline", label: "pipeline", note: "Host prepares, guest computes, host reports." },
  { id: "approval-demo", label: "approval-demo", note: "Parks at a human gate, then writes a file in the guest." },
];

const TERMINAL = new Set(["finished", "failed", "cancelled", "canceled", "error"]);

export function App() {
  const [run, setRun] = useState(null);
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [health, setHealth] = useState(null);
  const pollRef = useRef(null);

  const post = useCallback((message) => {
    try {
      window.parent?.postMessage(message, "*");
    } catch {
      // Not embedded, or a parent that refuses messages. The app still works.
    }
  }, []);

  // Report every state change to the hosting page so its buttons and status
  // line reflect the same engine state this app is showing.
  useEffect(() => {
    post({
      type: "stereos-state",
      status: run?.status ?? "idle",
      workflow: run?.workflow ?? null,
      runId: run?.runId ?? null,
      elapsedMs: run?.elapsedMs ?? null,
      guest: run?.result?.guest ?? null,
      error,
    });
  }, [run, error, post]);

  useEffect(() => {
    let live = true;
    const read = () =>
      fetch("/api/health")
        .then((r) => r.json())
        .then((h) => live && setHealth(h))
        .catch(() => {});
    read();
    const timer = setInterval(read, 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  const poll = useCallback((runId) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const next = await (await fetch(\`/api/runs/\${runId}\`)).json();
        if (next.error) return;
        setRun(next);
        if (TERMINAL.has(next.status)) clearInterval(pollRef.current);
      } catch {
        // Transient; the next tick retries.
      }
    }, 1_000);
  }, []);

  const start = useCallback(
    async (workflow) => {
      setBusy(true);
      setError(null);
      setRun(null);
      setToken(null);
      try {
        const response = await fetch("/api/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workflow }),
        });
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(body.error ?? \`start failed (\${response.status})\`);
        setToken(body.token);
        setRun({ runId: body.runId, workflow, status: "running", nodes: [], result: null });
        poll(body.runId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [poll],
  );

  const decide = useCallback(
    async (approved) => {
      if (!run || !token) return;
      setBusy(true);
      try {
        const response = await fetch(\`/api/runs/\${run.runId}/approval\`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, approved }),
        });
        const body = await response.json();
        if (!response.ok || body.error) throw new Error(body.error ?? "decision failed");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [run, token],
  );

  // The hosting page drives the same actions its own buttons expose.
  useEffect(() => {
    const onMessage = (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "stereos-start" && typeof data.workflow === "string") {
        if (WORKFLOWS.some((w) => w.id === data.workflow)) start(data.workflow);
      }
      // The page started the run itself and is handing over its token, so the
      // Approve button in here can resolve that run.
      if (data.type === "stereos-adopt" && typeof data.runId === "string" && typeof data.token === "string") {
        setError(null);
        setToken(data.token);
        setRun({ runId: data.runId, workflow: data.workflow, status: "running", nodes: [], result: null });
        poll(data.runId);
      }
      if (data.type === "stereos-approve") decide(data.approved !== false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [start, decide, poll]);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const waiting = run?.status === "waiting-approval";
  const guest = run?.result?.guest ?? null;
  const stages = (run?.nodes ?? []).map((node) => ({ label: node.label, status: node.status }));

  return (
    <WorkflowUiShell
      title="stereOS demo runs"
      meta={
        health ? (
          <span data-testid="capacity" style={{ fontSize: 12, opacity: 0.7 }}>
            {health.active}/{health.capacity} running{health.queued > 0 ? \`, \${health.queued} queued\` : ""}
          </span>
        ) : null
      }
      testId="stereos-demo-app"
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {WORKFLOWS.map((workflow) => (
          <Button
            key={workflow.id}
            type="button"
            size="sm"
            variant={run?.workflow === workflow.id ? "default" : "outline"}
            disabled={busy}
            title={workflow.note}
            data-testid={\`start-\${workflow.id}\`}
            onClick={() => start(workflow.id)}
          >
            {workflow.label}
          </Button>
        ))}
      </div>

      {error ? (
        <p data-testid="demo-error" style={{ color: "#c0392b", fontSize: 13 }}>
          {error}
        </p>
      ) : null}

      {run ? (
        <Card data-testid="run-card" data-run-status={run.status} data-workflow={run.workflow}>
          <CardHeader>
            <CardTitle style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <code style={{ fontSize: 13 }}>{run.workflow}</code>
              <StatusPill status={run.status} />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <StageStrip stages={stages} style={{ marginBottom: 12 }} />

            {waiting ? (
              <div data-testid="approval-panel" style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0" }}>
                <span style={{ fontSize: 13 }}>Apply the change inside the VM?</span>
                <Button type="button" size="sm" disabled={busy} data-testid="approve" onClick={() => decide(true)}>
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  data-testid="deny"
                  onClick={() => decide(false)}
                >
                  Deny
                </Button>
              </div>
            ) : null}

            {guest ? (
              <div
                data-testid="guest-evidence"
                style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}
              >
                <KpiStat label="Guest host" value={guest.hostname} />
                <KpiStat label="Guest kernel" value={guest.kernel} />
                <KpiStat label="Guest OS" value={guest.os} />
                <KpiStat label="Guest Bun" value={\`\${guest.bun} \${guest.arch}\`} />
                <KpiStat label="Sandbox" value={\`\${run.elapsedMs} ms\`} />
                <KpiStat label="Write outside workspace" value={guest.writeOutsideWorkspace} />
              </div>
            ) : null}

            {run.result ? (
              <pre
                data-testid="run-result"
                style={{
                  marginTop: 12,
                  maxHeight: 180,
                  overflow: "auto",
                  fontSize: 11,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {JSON.stringify(run.result, null, 2)}
              </pre>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          data-testid="demo-empty"
          title="No run yet"
          description="Pick a workflow. Each one boots its body inside a real stereOS VM on the demo host."
        />
      )}
    </WorkflowUiShell>
  );
}
`,"apps/stereos-site/service/ui/src/main.jsx":`import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,"apps/stereos-site/service/workflows/approval-demo.tsx":`/** @jsxImportSource smthrs */
/**
 * approval-demo - the run parks at a human gate, then applies the approved
 * change inside a booted stereOS VM.
 *
 * The \`<Approval>\` is a host concern: the engine leaves the run in
 * \`waiting-approval\` until a decision arrives through the gateway. The guard
 * accepts that decision only from whoever holds the run's start token. The
 * \`<Sandbox>\` that follows runs the authorized work in the guest.
 */
import { Approval, createSmithers, Sandbox, Sequence } from "smthrs";
import { z } from "zod";
import childWorkflow, { applyResultSchema } from "../guest-apply.tsx";
import { createStereosProvider } from "../stereos-provider.ts";

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({ change: z.string().default("write approved-change.txt in the guest workspace") }),
  // The engine writes { approved, decidedBy, decidedAt, note } and sets
  // decidedBy to null for an unattributed decision, so these fields must be
  // nullish rather than optional.
  decision: z.object({
    approved: z.boolean(),
    decidedBy: z.string().nullish(),
    note: z.string().nullish(),
  }),
  applied: applyResultSchema,
});

const provider = createStereosProvider({ id: "approval", guestEntry: "guest-apply.tsx" });

export default smithers((ctx) => {
  // The gate's own output decides whether the guest work is authorized. A
  // denial skips the Sandbox entirely, so nothing runs in the VM.
  const decision = ctx.outputMaybe("decision", { nodeId: "gate" });
  // Gateway UI discovery renders with no input, so read it defensively.
  const change = ctx.input?.change ?? "write approved-change.txt in the guest workspace";
  return (
    <Workflow name="approval-demo">
      <Sequence>
        <Approval
          id="gate"
          output={outputs.decision}
          request={{
            title: "Apply the change inside the stereOS VM?",
            summary: \`This run stays paused until someone decides: \${change}\`,
          }}
        />

        <Sandbox
          id="stereos-vm"
          provider={provider}
          workflow={childWorkflow}
          input={{ change: change, approved: decision?.approved === true }}
          output={outputs.applied}
          skipIf={decision != null && decision.approved !== true}
          allowNetwork
          reviewDiffs={false}
          timeoutMs={120_000}
          retries={1}
        />
      </Sequence>
    </Workflow>
  );
});
`,"apps/stereos-site/service/workflows/hello.tsx":`/** @jsxImportSource smthrs */
/**
 * hello - the smallest demo run. One \`<Sandbox>\` whose body executes inside a
 * booted stereOS VM over the SSH provider.
 */
import { createSmithers, Sandbox } from "smthrs";
import { z } from "zod";
import childWorkflow, { helloResultSchema } from "../guest-hello.tsx";
import { createStereosProvider } from "../stereos-provider.ts";

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({ name: z.string().default("stereOS") }),
  result: helloResultSchema,
});

const provider = createStereosProvider({ id: "hello", guestEntry: "guest-hello.tsx" });

export default smithers((ctx) => (
  <Workflow name="hello">
    <Sandbox
      id="stereos-vm"
      provider={provider}
      workflow={childWorkflow}
      input={{ name: ctx.input?.name ?? "stereOS" }}
      output={outputs.result}
      allowNetwork
      reviewDiffs={false}
      timeoutMs={120_000}
      retries={1}
    />
  </Workflow>
));
`,"apps/stereos-site/service/workflows/pipeline.tsx":`/** @jsxImportSource smthrs */
/**
 * pipeline - a \`<Sequence>\` whose second stage is a \`<Sandbox>\` running in a
 * booted stereOS VM. The host prepares the input, the guest does the work, and
 * the host summarizes what the guest returned, so the run exercises real output
 * persistence and dependency resolution across the host/guest boundary.
 */
import { createSmithers, Sandbox, Sequence, Task } from "smthrs";
import { z } from "zod";
import childWorkflow, { pipelineResultSchema } from "../guest-pipeline.tsx";
import { createStereosProvider } from "../stereos-provider.ts";

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({ text: z.string().default("Smithers runs this inside a real VM") }),
  prepared: z.object({ text: z.string(), chars: z.number() }),
  computed: pipelineResultSchema,
  summary: z.object({ report: z.string(), ranOn: z.string() }),
});

const provider = createStereosProvider({ id: "pipeline", guestEntry: "guest-pipeline.tsx" });

export default smithers((ctx) => {
  // Gateway UI discovery renders the workflow with no input, so read the text
  // defensively rather than through the parsed default.
  const text = ctx.input?.text ?? "Smithers runs this inside a real VM";
  return (
    <Workflow name="pipeline">
      <Sequence>
        <Task id="prepare" output={outputs.prepared}>
          {{ text, chars: text.length }}
        </Task>

        <Sandbox
          id="stereos-vm"
          provider={provider}
          workflow={childWorkflow}
          input={{ text }}
          output={outputs.computed}
          allowNetwork
          reviewDiffs={false}
          timeoutMs={120_000}
          retries={1}
        />

        {/* The dep key is resolved as an upstream task id, so \`needs\` points it
            at the sandbox node that actually produces this output. */}
        <Task
          id="report"
          output={outputs.summary}
          deps={{ computed: outputs.computed }}
          needs={{ computed: "stereos-vm" }}
        >
          {(deps) => ({ report: deps.computed.report, ranOn: deps.computed.guest.hostname })}
        </Task>
      </Sequence>
    </Workflow>
  );
});
`};var j=X(he(),1),Ev=X(bh(),1);var Cv="https://github.com/smithersai/smithers/blob/main",xh="apps/stereos-site/",$u=Object.keys(Su).sort(),Tu=e=>e.startsWith(xh)?e.slice(xh.length):e,Av=e=>$u.find(t=>Tu(t)===e)??e,Ov=$u.map(Tu),Rv=[[/^apps\/stereos-site\/service\//,"Demo service","The gateway workspace, the guard, and the systemd units behind the Live demo tab."],[/^apps\/stereos-site\/real\//,"Recorded runs","The provider, guest workflow, and host scripts that produced the captures."],[/^apps\/stereos-site\/page\//,"This page","The page shell and the scripts behind each tab."],[/^apps\/stereos-site\//,"Build and checks","The site build and the end-to-end check that runs against production."]],zv=e=>Rv.find(([t])=>t.test(e))??[null,"Source",""],_v={ts:"typescript",tsx:"tsx",js:"javascript",jsx:"jsx",mjs:"javascript",sh:"shell",md:"markdown",toml:"toml",json:"json",html:"html",css:"css",svg:"svg",service:"systemd"},Mv=e=>_v[e.split(".").pop()??""]??"text",Bv=new RegExp(`\\b(${["import","export","from","const","let","var","function","return","async","await","if","else","for","while","try","catch","finally","throw","new","class","extends","type","interface","default","as","of","in","typeof","instanceof","void","null","undefined","true","false","this","set","exec","echo","then","fi","do","done","local","sudo","systemctl"].join("|")})\\b`,"g");function Hv(e,t){if(t==="markdown"||t==="text")return[{text:e}];let n=/(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)/g,a=[],o=0;for(let i of e.matchAll(n)){i.index>o&&a.push(...vh(e.slice(o,i.index)));let s=i[0],l=s.startsWith("//")||s.startsWith("/*")||s.startsWith("#")?"comment":"string";a.push({text:s,kind:l}),o=i.index+s.length}return o<e.length&&a.push(...vh(e.slice(o))),a}function vh(e){let t=[],n=0;for(let a of e.matchAll(Bv))a.index>n&&t.push({text:e.slice(n,a.index)}),t.push({text:a[0],kind:"keyword"}),n=a.index+a[0].length;return n<e.length&&t.push({text:e.slice(n)}),t}var Nv={comment:"var(--muted)",string:"var(--green)",keyword:"var(--purple)"};function Dv(){let[e,t]=(0,Ri.useState)("apps/stereos-site/service/guard.ts"),n=Su[e]??"",a=Mv(e),o=(0,Ri.useMemo)(()=>Hv(n,a),[n,a]),[,i,s]=zv(e),l=n?n.split(`
`).length:0;return(0,j.jsxs)("div",{style:{display:"grid",gridTemplateColumns:"minmax(220px, 300px) minmax(0, 1fr)",gap:14,alignItems:"start"},children:[(0,j.jsxs)(Ti,{"data-testid":"impl-tree",children:[(0,j.jsx)(Ei,{children:(0,j.jsxs)(Ci,{style:{fontSize:13},children:[$u.length," files ",(0,j.jsx)($i,{variant:"muted",children:"read at build time"})]})}),(0,j.jsx)(Ai,{style:{maxHeight:620,overflow:"auto"},children:(0,j.jsx)(yu,{nodes:Ov,selected:Tu(e),onSelect:u=>t(Av(u))})})]}),n?(0,j.jsxs)(Ti,{"data-testid":"impl-viewer","data-path":e,children:[(0,j.jsx)(Ei,{children:(0,j.jsxs)(Ci,{style:{display:"flex",flexWrap:"wrap",gap:8,alignItems:"center",fontSize:13},children:[(0,j.jsx)("code",{"data-testid":"impl-path",style:{fontSize:12},children:e}),(0,j.jsx)(wu,{status:"ok",label:a}),(0,j.jsxs)($i,{variant:"muted",children:[l," lines"]}),(0,j.jsx)(xu,{asChild:!0,size:"sm",variant:"outline",style:{marginLeft:"auto"},children:(0,j.jsx)("a",{href:`${Cv}/${e}`,target:"_blank",rel:"noreferrer","data-testid":"impl-github",children:"View on GitHub"})})]})}),(0,j.jsxs)(Ai,{children:[(0,j.jsxs)("p",{style:{margin:"0 0 10px",color:"var(--muted)",fontSize:12,lineHeight:1.5},children:[(0,j.jsxs)("strong",{style:{color:"var(--ink)"},children:[i,"."]})," ",s]}),(0,j.jsx)("pre",{"data-testid":"impl-source",style:{margin:0,maxHeight:560,overflow:"auto",padding:"12px 14px",color:"var(--ink)",background:"var(--diagram)",border:"1px solid var(--line)",borderRadius:10,font:"11.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace",whiteSpace:"pre"},children:o.map((u,c)=>(0,j.jsx)("span",{style:u.kind?{color:Nv[u.kind]}:void 0,children:u.text},c))})]})]}):(0,j.jsx)(vu,{title:"Pick a file",description:"Every source that runs the demo is in the tree."})]})}var yh=document.getElementById("impl-root");yh&&(0,wh.createRoot)(yh).render((0,j.jsx)(Dv,{}));
/*! Bundled license information:

scheduler/cjs/scheduler.production.js:
  (**
   * @license React
   * scheduler.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react/cjs/react.production.js:
  (**
   * @license React
   * react.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react-dom/cjs/react-dom.production.js:
  (**
   * @license React
   * react-dom.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react-dom/cjs/react-dom-client.production.js:
  (**
   * @license React
   * react-dom-client.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react/cjs/react-jsx-runtime.production.js:
  (**
   * @license React
   * react-jsx-runtime.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react/cjs/react-jsx-dev-runtime.production.js:
  (**
   * @license React
   * react-jsx-dev-runtime.production.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)
*/
