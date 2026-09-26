(function(){const e=document.createElement("link").relList;if(e&&e.supports&&e.supports("modulepreload"))return;for(const i of document.querySelectorAll('link[rel="modulepreload"]'))r(i);new MutationObserver(i=>{for(const n of i)if(n.type==="childList")for(const a of n.addedNodes)a.tagName==="LINK"&&a.rel==="modulepreload"&&r(a)}).observe(document,{childList:!0,subtree:!0});function t(i){const n={};return i.integrity&&(n.integrity=i.integrity),i.referrerPolicy&&(n.referrerPolicy=i.referrerPolicy),i.crossOrigin==="use-credentials"?n.credentials="include":i.crossOrigin==="anonymous"?n.credentials="omit":n.credentials="same-origin",n}function r(i){if(i.ep)return;i.ep=!0;const n=t(i);fetch(i.href,n)}})();class $r{_subscribers=new Map;_responders=new Map;_streamHandlers=new Map;publish(e,t){const r=this._subscribers.get(e);if(r)for(const i of[...r])try{i(t)}catch(n){console.error(`signals: subscriber for channel "${e}" threw — delivery continues.`,n)}}subscribe(e,t){let r=this._subscribers.get(e);r||(r=new Set,this._subscribers.set(e,r));const i=t;return r.add(i),()=>{r.delete(i),r.size===0&&this._subscribers.delete(e)}}async request(e,t){const r=this._responders.get(e);if(!r)throw new Error(`No responder registered for channel: ${e}`);return await r(t)}respond(e,t){if(this._responders.has(e))throw new Error(`Responder already registered for channel: ${e}`);return this._responders.set(e,t),()=>{this._responders.delete(e)}}handleStream(e,t){if(this._streamHandlers.has(e))throw new Error(`Stream handler already registered for channel: ${e}`);return this._streamHandlers.set(e,t),()=>{this._streamHandlers.delete(e)}}stream(e,t){const r=this._streamHandlers.get(e);if(!r)throw new Error(`No stream handler registered for channel: ${e}`);const i=[],n=[];let a=!1,o=null;function c(u){const b=n.shift();b?b.resolve(u):i.push(u)}const l={push(u){a||c({value:u,done:!1})},close(){if(!a)for(a=!0,c({value:void 0,done:!0});n.length>0;)n.shift().resolve({value:void 0,done:!0})},error(u){if(!a)for(a=!0,o=u,i.length=0;n.length>0;)n.shift().reject(u)}},d=r(t,l);d instanceof Promise&&d.catch(u=>{const b=u instanceof Error?u:new Error(String(u));l.error(b)});const h={next(){return o?Promise.reject(o):i.length>0?Promise.resolve(i.shift()):a?Promise.resolve({value:void 0,done:!0}):new Promise((u,b)=>{n.push({resolve:u,reject:b})})}};return{[Symbol.asyncIterator](){return h}}}consume(e,t){return this.subscribe(e,r=>{t(r.chunk,r.done)})}get subscriberCount(){let e=0;for(const t of this._subscribers.values())e+=t.size;return e}get activeChannels(){return[...this._subscribers.keys()]}reset(){this._subscribers.clear(),this._responders.clear(),this._streamHandlers.clear()}}const $e=new $r,Vt="evolution-ui-theme",Cr="ev:theme-change",Mr=["windows","macos","ubuntu","cyberpunk","neutral"],zr=["light","dark","high-contrast"];function lt(s){return typeof s=="string"&&Mr.includes(s)}function ct(s){return typeof s=="string"&&zr.includes(s)}function dt(){return globalThis.document?.documentElement??null}function je(){try{const s=globalThis.localStorage?.getItem(Vt);if(!s)return{};const e=JSON.parse(s);if(typeof e!="object"||e===null)return{};const t=e,r={};return lt(t.platform)&&(r.platform=t.platform),ct(t.mode)&&(r.mode=t.mode),r}catch{return{}}}function Ar(s){try{globalThis.localStorage?.setItem(Vt,JSON.stringify(s))}catch{}}function Ut(s){const e=dt();e&&(s==="neutral"?e.removeAttribute("data-platform"):e.setAttribute("data-platform",s))}function Ge(s){dt()?.setAttribute("data-theme",s)}function Je(){$e.publish(Cr,Le())}function Le(){const s=dt(),e=s?.getAttribute("data-platform"),t=s?.getAttribute("data-theme");return{platform:lt(e)?e:"neutral",mode:ct(t)?t:null}}function Lr(s){const e=je();let t=!1;s.platform!==void 0&&lt(s.platform)&&(Ut(s.platform),e.platform=s.platform,t=!0),s.mode!==void 0&&ct(s.mode)&&(Ge(s.mode),e.mode=s.mode,t=!0),t&&(Ar(e),Je())}function Er(){const s=globalThis.navigator;if(!s)return null;const e=s.userAgentData?.platform;if(typeof e=="string"&&e.length>0)return gt(e);const t=s.userAgent;return typeof t=="string"&&t.length>0?gt(t):null}function gt(s){return/win/i.test(s)?"windows":/mac/i.test(s)?"macos":/ubuntu|linux/i.test(s)?"ubuntu":null}let qe=null;function Tr(s={}){const e=je();let t=e.platform??null;t===null&&s.autoDetectPlatform&&(t=Er()),t!==null&&Ut(t);const r=typeof globalThis.matchMedia=="function"?globalThis.matchMedia("(prefers-color-scheme: dark)"):null,i=e.mode??(r?.matches?"dark":"light");if(Ge(i),Je(),qe?.(),qe=null,r&&typeof r.addEventListener=="function"){const n=a=>{je().mode===void 0&&(Ge(a.matches?"dark":"light"),Je())};r.addEventListener("change",n),qe=()=>r.removeEventListener("change",n)}return Le()}function yt(s){return s.replace(/[A-Z]/g,e=>`-${e.toLowerCase()}`)}function Rr(s){return s.replace(/-([a-z])/g,(e,t)=>t.toUpperCase())}function Ir(s,e,t){if(s===null)return e==="boolean"?!1:null;switch(e){case"number":{const r=Number(s);return Number.isNaN(r)&&console.warn(`${t??"EvElement"}: attribute value ${JSON.stringify(s)} coerced to NaN for a number prop.`),r}case"boolean":return s!=="false";case"object":try{return JSON.parse(s)}catch{return console.warn(`${t??"EvElement"}: attribute value is not valid JSON for an object prop; using {}. Value: ${JSON.stringify(s)}`),{}}default:return s}}function R(s,...e){let t="";for(let r=0;r<s.length;r++)t+=s[r],r<e.length&&(t+=String(e[r]??""));return t}const Dr=/[&<>"']/g,Hr={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};function Nr(s){return s.replace(Dr,e=>Hr[e])}class ze{constructor(e){this._html=e}toString(){return this._html}}function te(s){return s instanceof ze?s:new ze(s)}function jt(s){return s==null?"":s instanceof ze?s.toString():Array.isArray(s)?s.map(jt).join(""):Nr(String(s))}function _(s,...e){let t="";for(let r=0;r<s.length;r++)t+=s[r],r<e.length&&(t+=jt(e[r]));return new ze(t)}class A extends HTMLElement{shadow;static props={};static styles="";_propStore=new Map;_renderPending=!1;_connected=!1;_signalCleanups=[];_listenerCleanups=[];_transientListenerCleanups=[];_stableTemplateReady=!1;_stableBindingsReady=!1;_inBindEvents=!1;_inSyncDom=!1;_reflecting=!1;_settingFromAttribute=!1;_preUpgradeValues=null;constructor(){super(),this.shadow=this.attachShadow({mode:"open"}),this._defineReactiveProps()}static get observedAttributes(){return Object.entries(this.props).filter(([,e])=>e.reflect!==!1).map(([e])=>yt(e))}attributeChangedCallback(e,t,r){if(t===r||this._reflecting)return;const i=Rr(e),a=this.constructor.props[i];if(!a)return;const o=Ir(r,a.type,`<${this.tagName.toLowerCase()}> ${e}`);this._settingFromAttribute=!0;try{this[i]=o}finally{this._settingFromAttribute=!1}}connectedCallback(){if(this._preUpgradeValues){const e=this._preUpgradeValues;this._preUpgradeValues=null;for(const[t,r]of e)this[t]=r}this._connected=!0,this._applyDefaults(),this._render(),this.onConnect()}disconnectedCallback(){this._connected=!1,this._stableBindingsReady=!1,this._cleanupManagedListeners(),this._cleanupSignals(),this.onDisconnect()}onConnect(){}onDisconnect(){}onRender(){}get renderMode(){return"replace"}bindEvents(){}syncDom(){}update(){this._scheduleRender()}_scheduleRender(){if(this._inBindEvents)throw new Error(`<${this.tagName.toLowerCase()}>: update() (or a reactive prop set) was called during bindEvents(). render → bindEvents → update is an infinite render loop. Mutate the DOM directly in bindEvents (classList/style/textContent) instead of triggering a re-render.`);this._renderPending||(this._renderPending=!0,queueMicrotask(()=>{this._renderPending=!1,this._connected&&this._render()}))}static _sheetCache=new Map;static _baseSheet=null;static _getBaseSheet(){return A._baseSheet||(A._baseSheet=new CSSStyleSheet,A._baseSheet.replaceSync("*, *::before, *::after { box-sizing: border-box; }")),A._baseSheet}_adoptStyles(){const e=this.constructor;let t=A._sheetCache.get(e);t||(t=new CSSStyleSheet,t.replaceSync(this._collectStyles()),A._sheetCache.set(e,t)),this.shadow.adoptedStyleSheets[1]!==t&&(this.shadow.adoptedStyleSheets=[A._getBaseSheet(),t])}_render(){if(this._adoptStyles(),this.renderMode==="stable"){let t=this.shadow.querySelector("[data-ev-root]");if(!t||!this._stableTemplateReady){if(this._cleanupManagedListeners(),this.shadow.innerHTML="<div data-ev-root></div>",t=this.shadow.querySelector("[data-ev-root]"),!t)return;t.innerHTML=String(this.render()),this._callBindEvents(),this._stableTemplateReady=!0,this._stableBindingsReady=!0}else this._stableBindingsReady||(this._callBindEvents(),this._stableBindingsReady=!0);this._cleanupTransientListeners(),this._inSyncDom=!0;try{this.syncDom()}finally{this._inSyncDom=!1}this.onRender();return}this.shadow.activeElement&&A._warnFocusDestroyed(this.tagName);const e=String(this.render());this._cleanupManagedListeners(),this.shadow.innerHTML=e,this._callBindEvents(),this.onRender()}_callBindEvents(){this._inBindEvents=!0;try{this.bindEvents()}finally{this._inBindEvents=!1}}static _focusWarned=new Set;static _warnFocusDestroyed(e){const t=e.toLowerCase();A._focusWarned.has(t)||(A._focusWarned.add(t),console.warn(`<${t}>: re-render in 'replace' mode is destroying the currently focused element inside its shadow root. Interaction state (focus, caret, drag) is lost. Convert this component to renderMode 'stable' + syncDom().`))}_collectStyles(){const e=[];let t=this.constructor;for(;t&&t.prototype!==HTMLElement.prototype;)Object.prototype.hasOwnProperty.call(t,"styles")&&typeof t.styles=="string"&&t.styles&&e.unshift(t.styles),t=Object.getPrototypeOf(t);return e.join(`
`)}emit(e,t){e.startsWith("ev-")||console.warn(`<${this.tagName.toLowerCase()}>: emit('${e}') — component events must use the 'ev-' prefix.`),this.dispatchEvent(new CustomEvent(e,{detail:t,bubbles:!0,composed:!0}))}on(e,t){const r=e.startsWith("ev-")?e:`ev-${e}`,i=n=>t(n.detail);return this.addEventListener(r,i),()=>this.removeEventListener(r,i)}publish(e,t){$e.publish(e,t)}subscribe(e,t){const r=$e.subscribe(e,t);this._signalCleanups.push(r)}request(e,t){return $e.request(e,t)}_loadDataController=null;async loadData(e){if(!e)return[];this._loadDataController?.abort();const t=new AbortController;this._loadDataController=t;try{const r=await fetch(e,{headers:{Accept:"application/json"},signal:t.signal});if(!r.ok)throw new Error(`Data fetch failed: ${r.status}`);return await r.json()}catch(r){if(t.signal.aborted)return[];throw r}finally{this._loadDataController===t&&(this._loadDataController=null)}}query(e){return this.shadow.querySelector(e)}queryAll(e){return this.shadow.querySelectorAll(e)}ref(e){return this.shadow.querySelector(`[data-ref="${e}"]`)}listen(e,t,r,i){if(!e)return()=>{};e.addEventListener(t,r,i);const n=()=>{e.removeEventListener(t,r,i)};return this._inSyncDom?this._transientListenerCleanups.push(n):this._listenerCleanups.push(n),n}_defineReactiveProps(){const e=this.constructor;for(const[t,r]of Object.entries(e.props))Object.prototype.hasOwnProperty.call(this,t)&&(this._preUpgradeValues??=new Map,this._preUpgradeValues.set(t,this[t]),delete this[t]),Object.defineProperty(this,t,{get:()=>{const i=this._propStore.get(t);if(i!==void 0)return i;if(r.default!==null&&typeof r.default=="object"){const n=Array.isArray(r.default)?[...r.default]:{...r.default};return this._propStore.set(t,n),n}return r.default},set:i=>{const n=this._propStore.get(t);if(!Object.is(n,i)){if(this._propStore.set(t,i),r.reflect&&!this._settingFromAttribute){this._reflecting=!0;try{this._reflectToAttribute(t,i)}finally{this._reflecting=!1}}this._connected&&this._scheduleRender()}},configurable:!0,enumerable:!0})}_reflectToAttribute(e,t){const r=yt(e);t==null||t===!1?this.removeAttribute(r):t===!0?this.setAttribute(r,""):typeof t=="object"?this.setAttribute(r,JSON.stringify(t)):this.setAttribute(r,String(t))}_applyDefaults(){const e=this.constructor;for(const[t,r]of Object.entries(e.props))if(r.default!==void 0&&this._propStore.get(t)===void 0){const i=r.default!==null&&typeof r.default=="object"?Array.isArray(r.default)?[...r.default]:{...r.default}:r.default;this._propStore.set(t,i)}}_cleanupSignals(){for(const e of this._signalCleanups)e();this._signalCleanups=[]}_cleanupManagedListeners(){for(const e of this._listenerCleanups)e();this._listenerCleanups=[],this._cleanupTransientListeners()}_cleanupTransientListeners(){for(const e of this._transientListenerCleanups)e();this._transientListenerCleanups=[]}}class Gt extends A{static formAssociated=!0;internals;_initialValue;_initialCaptured=!1;constructor(){super(),this.internals=this.attachInternals()}get formValue(){const e=this.value;return e==null||e===""?null:String(e)}computeValidity(){const e=this.required,t=this.formValue,r=t===null||typeof t=="string"&&t.length===0;return e&&r?{flags:{valueMissing:!0},message:"Please fill in this field."}:{flags:{},message:""}}get validationAnchor(){}get formResetValue(){return this._initialValue}applyFormResetValue(){this.value=this.formResetValue}syncFormState(){this.internals.setFormValue(this.formValue);const{flags:e,message:t}=this.computeValidity();this.internals.setValidity(e,t,this.validationAnchor)}onRender(){super.onRender(),this._initialCaptured||(this._initialCaptured=!0,this._initialValue=this.value),this.syncFormState()}get form(){return this.internals.form}get validity(){return this.internals.validity}get validationMessage(){return this.internals.validationMessage}checkValidity(){return this.internals.checkValidity()}reportValidity(){return this.internals.reportValidity()}formResetCallback(){this.applyFormResetValue(),this.syncFormState()}formDisabledCallback(e){this.disabled=e}formStateRestoreCallback(e,t){typeof e=="string"&&(this.value=e)}}const Br="0.9.0-beta.0",_t=new Map;function I(s,e){const t=customElements.get(s);if(!t){customElements.define(s,e),_t.set(s,e);return}t!==e&&!_t.has(s)&&console.warn(`evolution-ui: <${s}> is already defined by a different class — skipping re-registration. This usually means two copies/versions of Evolution UI are loaded on this page (this copy: ${Br}). Dedupe the dependency to avoid mixed-version behavior.`)}const H=[];let we=!1;function wt(s){if(s.key!=="Escape"||H.length===0)return;const e=H[H.length-1];s.preventDefault(),s.stopPropagation(),e.close("escape")}function xt(s){if(H.length===0)return;const e=H[H.length-1];if(e.closeOnOutsideClick===!1)return;const t=s.composedPath();(e.contains?e.contains(t):t.includes(e.host))||e.close("outside-click")}function kt(){H.length>0&&!we?(document.addEventListener("keydown",wt,!0),document.addEventListener("mousedown",xt),we=!0):H.length===0&&we&&(document.removeEventListener("keydown",wt,!0),document.removeEventListener("mousedown",xt),we=!1)}function Pr(s,e){const t={host:s,...e};return{opened(){H.includes(t)||(H.push(t),kt())},closed(){const r=H.indexOf(t);r!==-1&&(H.splice(r,1),kt())},get isOpen(){return H.includes(t)}}}class qr{_commands=new Map;_listeners=new Set;register(e){return this._commands.set(e.id,e),this._notify(),()=>{this._commands.get(e.id)===e&&(this._commands.delete(e.id),this._notify())}}unregister(e){this._commands.delete(e)&&this._notify()}get(e){return this._commands.get(e)}getAll(e=!1){const t=[...this._commands.values()];return e?t:t.filter(r=>r.when?r.when():!0)}isEnabled(e){const t=this._commands.get(e);return t?typeof t.enabled=="function"?t.enabled():t.enabled!==!1:!1}execute(e,...t){const r=this._commands.get(e);return!r||!this.isEnabled(e)?!1:(r.run(...t),!0)}refresh(){this._notify()}onDidChange(e){return this._listeners.add(e),()=>this._listeners.delete(e)}_notify(){for(const e of this._listeners)e()}}const j=new qr,Jt=typeof navigator<"u"&&/Mac|iPhone|iPad/.test(navigator.platform??""),Or={esc:"escape",space:" ",plus:"+",up:"arrowup",down:"arrowdown",left:"arrowleft",right:"arrowright",del:"delete",return:"enter"};function Wr(s){const e=s.split("+").map(r=>r.trim()),t={key:"",ctrl:!1,shift:!1,alt:!1,meta:!1};for(const r of e){const i=r.toLowerCase();i==="mod"?Jt?t.meta=!0:t.ctrl=!0:i==="ctrl"||i==="control"?t.ctrl=!0:i==="shift"?t.shift=!0:i==="alt"||i==="option"?t.alt=!0:i==="meta"||i==="cmd"||i==="win"?t.meta=!0:t.key=Or[i]??i}return t}function Fr(s){return s.split(/\s+/).filter(Boolean).map(Wr)}const xe={meta:"⌘",ctrl:"⌃",alt:"⌥",shift:"⇧"};function St(s){return s===" "?"Space":s.startsWith("arrow")?{arrowup:"↑",arrowdown:"↓",arrowleft:"←",arrowright:"→"}[s]??s:s.length===1?s.toUpperCase():s.charAt(0).toUpperCase()+s.slice(1)}function Kr(s){return Fr(s).map(e=>{if(Jt){let r="";return e.ctrl&&(r+=xe.ctrl),e.alt&&(r+=xe.alt),e.shift&&(r+=xe.shift),e.meta&&(r+=xe.meta),r+St(e.key)}const t=[];return e.ctrl&&t.push("Ctrl"),e.alt&&t.push("Alt"),e.shift&&t.push("Shift"),e.meta&&t.push("Win"),t.push(St(e.key)),t.join("+")}).join(" ")}let Vr=1;const re=new Map;function Ur(){return typeof document<"u"&&document.visibilityState==="hidden"}function X(s){const e=Vr++;if(Ur()||typeof requestAnimationFrame>"u"){const r=setTimeout(()=>{re.delete(e),s(typeof performance>"u"?Date.now():performance.now())},0);return re.set(e,{kind:"timeout",id:r}),e}const t=requestAnimationFrame(r=>{re.delete(e),s(r)});return re.set(e,{kind:"frame",id:t}),e}function jr(s){if(s==null)return;const e=re.get(s);e&&(re.delete(s),e.kind==="timeout"?clearTimeout(e.id):cancelAnimationFrame(e.id))}class Gr{_undo=[];_redo=[];_group=null;_listeners=new Set;_levels;constructor(e=100){this._levels=e}get canUndo(){return this._undo.length>0}get canRedo(){return this._redo.length>0}get undoLabel(){return this._undo[this._undo.length-1]?.label??null}get redoLabel(){return this._redo[this._redo.length-1]?.label??null}get depth(){return this._undo.length}push(e){if(this._group){this._group.units.push(e);return}this._undo.push(e),this._undo.length>this._levels&&this._undo.shift(),this._redo=[],this._notify()}beginGroup(e){if(this._group){this._groupDepth++;return}this._group={label:e,units:[]},this._groupDepth=1}_groupDepth=0;endGroup(){if(!this._group||(this._groupDepth--,this._groupDepth>0))return;const e=this._group;if(this._group=null,e.units.length===0)return;const t=[...e.units];this.push({label:e.label,undo:()=>{for(let r=t.length-1;r>=0;r--)t[r].undo()},redo:()=>{for(const r of t)r.redo()}})}group(e,t){this.beginGroup(e);try{return t()}finally{this.endGroup()}}undo(){const e=this._undo.pop();return e?(e.undo(),this._redo.push(e),this._notify(),!0):!1}redo(){const e=this._redo.pop();return e?(e.redo(),this._undo.push(e),this._notify(),!0):!1}clear(){this._undo=[],this._redo=[],this._group=null,this._groupDepth=0,this._notify()}onChange(e){return this._listeners.add(e),()=>this._listeners.delete(e)}_notify(){for(const e of this._listeners)e(this)}}const Jr=new Gr,Oe="evolution-ui-state:";class Yr{get(e){try{const t=localStorage.getItem(Oe+e);return t===null?void 0:JSON.parse(t)}catch{return}}set(e,t){try{localStorage.setItem(Oe+e,JSON.stringify(t))}catch{}}remove(e){try{localStorage.removeItem(Oe+e)}catch{}}}let ke=new Yr;function Yt(s,e){const{stateId:t,capture:r,restore:i,captureOn:n,debounceMs:a=250}=e,o=t,c=ke.get(o);if(c!==void 0)try{i(c)}catch{ke.remove(o)}let l=null;const d=()=>{l!==null&&(clearTimeout(l),l=null);try{ke.set(o,r())}catch{}},h=()=>{l!==null&&clearTimeout(l),l=window.setTimeout(d,a)},u=[];for(const b of n){const g=()=>h();s.addEventListener(b,g),u.push([b,g])}return{save:d,detach(){for(const[b,g]of u)s.removeEventListener(b,g);l!==null&&(clearTimeout(l),d())},clear(){l!==null&&(clearTimeout(l),l=null),ke.remove(o)}}}let $t=typeof navigator<"u"&&navigator.language?navigator.language:"en-US";const Ct=new Set;function Zt(s){return Ct.add(s),()=>Ct.delete(s)}const Xt={"common.close":"Close","common.clear":"Clear","common.cancel":"Cancel","common.confirm":"Confirm","common.loading":"Loading…","common.noData":"No data","common.today":"Today","grid.selectAll":"Select all rows","grid.selectRow":"Select row","grid.toggleDetails":"Toggle row details","palette.placeholder":"Type a command...","palette.noResults":"No commands found","upload.drop":"Drop files here or click to browse"},Mt=new Map([["en",Xt]]);function se(s){const e=$t.split("-")[0];return Mt.get($t)?.[s]??Mt.get(e)?.[s]??Xt[s]??s}class Zr{_mode;_keys=[];_index=new Map;_selected=new Set;_anchor=null;_lead=null;_listeners=new Set;constructor(e="single"){this._mode=e}get mode(){return this._mode}set mode(e){if(e!==this._mode){if(this._mode=e,e==="none"&&this._selected.size>0)this._selected.clear(),this._notify();else if(e==="single"&&this._selected.size>1){const t=this._lead??this._anchor??[...this._selected][this._selected.size-1];this._selected.clear(),t!=null&&this._selected.add(t),this._notify()}}}get anchor(){return this._anchor}get lead(){return this._lead}setKeys(e){this._keys=[...e],this._index.clear();for(let r=0;r<this._keys.length;r++)this._index.set(this._keys[r],r);let t=!1;for(const r of this._selected)this._index.has(r)||(this._selected.delete(r),t=!0);return this._anchor!==null&&!this._index.has(this._anchor)&&(this._anchor=null),this._lead!==null&&!this._index.has(this._lead)&&(this._lead=null),t&&this._notify(),t}get keys(){return this._keys}isSelected(e){return this._selected.has(e)}getSelected(){return this._keys.filter(e=>this._selected.has(e))}get size(){return this._selected.size}click(e,t={}){if(this._mode==="none"||!this._index.has(e))return!1;if(this._mode==="single")return this._anchor=e,this._lead=e,this._replace([e]);if(t.shift&&this._anchor!==null){const r=this._range(this._anchor,e);return this._lead=e,t.ctrl?this._add(r):this._replace(r)}return t.ctrl?(this._anchor=e,this._lead=e,this._toggle(e)):(this._anchor=e,this._lead=e,this._replace([e]))}navigate(e,t={}){return this._mode==="none"||!this._index.has(e)?!1:t.shift&&this._mode==="multi"?(this._anchor===null&&(this._anchor=this._lead??e),this._lead=e,this._replace(this._range(this._anchor,e))):t.ctrl?(this._lead=e,!1):(this._anchor=e,this._lead=e,this._replace([e]))}toggleAt(e){return this._mode==="none"||!this._index.has(e)?!1:(this._anchor=e,this._lead=e,this._mode==="single"?this._replace(this._selected.has(e)?[]:[e]):this._toggle(e))}selectAll(){return this._mode!=="multi"||this._keys.length===0||this._selected.size===this._keys.length?!1:(this._selected=new Set(this._keys),this._notify(),!0)}clear(){return this._selected.size===0?!1:(this._selected.clear(),this._notify(),!0)}select(e){const t=e.filter(i=>this._index.has(i)),r=this._mode==="single"?t.slice(0,1):t;return this._replace(r)}onChange(e){return this._listeners.add(e),()=>this._listeners.delete(e)}_range(e,t){const r=this._index.get(e),i=this._index.get(t);if(r===void 0||i===void 0)return[t];const[n,a]=r<=i?[r,i]:[i,r];return this._keys.slice(n,a+1)}_replace(e){return e.length===this._selected.size&&e.every(t=>this._selected.has(t))?!1:(this._selected=new Set(e),this._notify(),!0)}_add(e){let t=!1;for(const r of e)this._selected.has(r)||(this._selected.add(r),t=!0);return t&&this._notify(),t}_toggle(e){return this._selected.has(e)?this._selected.delete(e):this._selected.add(e),this._notify(),!0}_notify(){const e=this.getSelected();for(const t of this._listeners)t(e,this)}}class Xr{_buffer="";_lastTime=0;_timeoutMs;constructor(e={}){this._timeoutMs=e.timeoutMs??1e3}handleKey(e,t,r,i=Date.now()){if(e.length!==1)return-1;const n=i-this._lastTime;this._lastTime=i;const a=e.toLowerCase();n>this._timeoutMs&&(this._buffer="");const o=this._buffer.length>=1&&this._buffer.split("").every(h=>h===a);this._buffer=o?a:this._buffer+a;const c=this._buffer,l=t.length;if(l===0)return-1;const d=this._buffer.length>1&&!o?0:1;for(let h=0;h<l;h++){const u=(r+d+h+l)%l;if(t[u]?.toLowerCase().startsWith(c))return u}return-1}reset(){this._buffer="",this._lastTime=0}}function Qr(s,e,t=!1){for(let r=0;r<s.length;r++)s[r].tabIndex=r===e?0:-1;t&&e>=0&&e<s.length&&s[e].focus()}function ce(s){return s.ctrlKey||s.metaKey}function Qt(s,e){const{count:t,activeIndex:r,orientation:i,wrap:n,rtl:a}=e;if(t===0)return-1;const o=e.isDisabled??(()=>!1),c=i==="horizontal"||i==="both",l=i==="vertical"||i==="both";let d=0,h=null;switch(s){case"ArrowRight":if(!c)return-1;d=a?-1:1;break;case"ArrowLeft":if(!c)return-1;d=a?1:-1;break;case"ArrowDown":if(!l)return-1;d=1;break;case"ArrowUp":if(!l)return-1;d=-1;break;case"Home":h="first";break;case"End":h="last";break;default:return-1}const u=g=>!o(g);if(h){const g=h==="first"?0:t-1,w=h==="first"?1:-1;for(let p=g;p>=0&&p<t;p+=w)if(u(p))return p;return-1}if(r<0){for(let g=0;g<t;g++)if(u(g))return g;return-1}let b=r;for(let g=0;g<t;g++){if(b+=d,b<0||b>=t){if(!n)return-1;b=(b+t)%t}if(b===r)return-1;if(u(b))return b}return-1}const es=s=>s.hasAttribute("disabled")||s.getAttribute("aria-disabled")==="true";class ts{_opts;_typeAhead;_activeIndex=-1;constructor(e){this._opts=e,this._typeAhead=e.getLabel?new Xr:null}get activeIndex(){return this._activeIndex}sync(e){const t=this._opts.getItems();e!==void 0&&(this._activeIndex=e),this._activeIndex>=t.length&&(this._activeIndex=t.length-1);let r=this._activeIndex;(r<0||this._disabled(t[r],r))&&(r=this._firstEnabled(t),this._activeIndex=r),this._applyTabbable(t,r)}handleFocusIn(e){const t=this._opts.getItems(),r=this._indexOfTarget(t,e.target);r<0||(this._activeIndex=r,this._applyTabbable(t,r))}handleKeydown(e){if(e.defaultPrevented)return!1;const t=this._opts.getItems();if(t.length===0)return!1;if((this._opts.activateKeys??[]).includes(e.key)&&this._opts.onActivate){const n=this._indexOfTarget(t,e.target)>=0?this._indexOfTarget(t,e.target):this._activeIndex;return n>=0&&!this._disabled(t[n],n)?(e.preventDefault(),this._opts.onActivate(t[n],n,e.key==="Enter"?"enter":"space"),!0):!1}const i=Qt(e.key,{count:t.length,activeIndex:this._currentIndex(t,e.target),orientation:this._orientation(),wrap:this._opts.wrap??!0,rtl:this._isRtl(t),isDisabled:n=>this._disabled(t[n],n)});if(i>=0)return e.preventDefault(),this._moveTo(t,i,e),!0;if(["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(e.key))return!1;if(this._typeAhead&&this._opts.getLabel&&e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){const n=Array.from({length:t.length},(o,c)=>this._disabled(t[c],c)?"":this._opts.getLabel(t[c],c)),a=this._typeAhead.handleKey(e.key,n,this._currentIndex(t,e.target));if(a>=0)return e.preventDefault(),this._moveTo(t,a,e),!0}return!1}_moveTo(e,t,r){this._activeIndex=t,this._applyTabbable(e,t),this._opts.focusItem?this._opts.focusItem(e[t],t):e[t].focus(),this._opts.selectOnMove&&this._opts.onActivate&&this._opts.onActivate(e[t],t,"move")}_applyTabbable(e,t){if(this._opts.setTabbable)for(let r=0;r<e.length;r++)this._opts.setTabbable(e[r],r===t,r);else Qr(e,t,!1)}_orientation(){const e=this._opts.orientation??"both";return typeof e=="function"?e():e}_isRtl(e){const t=this._opts.rtlElement?.()??(e.length>0?e[0]:null);return t?getComputedStyle(t).direction==="rtl":!1}_disabled(e,t){return e?(this._opts.isDisabled??es)(e,t):!0}_firstEnabled(e){for(let t=0;t<e.length;t++)if(!this._disabled(e[t],t))return t;return-1}_indexOfTarget(e,t){if(!(t instanceof Node))return-1;for(let r=0;r<e.length;r++){const i=e[r];if(i===t||i.contains(t))return r;const n=t.getRootNode();if(n instanceof ShadowRoot&&n.host===i)return r}return-1}_currentIndex(e,t){const r=this._indexOfTarget(e,t);return r>=0?r:this._activeIndex}}function rs(s,e){let t=null;const r=(...i)=>{t!==null&&clearTimeout(t),t=setTimeout(()=>{t=null,s(...i)},e)};return r.cancel=()=>{t!==null&&(clearTimeout(t),t=null)},r}const ss=`
  :host([disabled]) {
    opacity: 0.5;
    pointer-events: none;
  }
`,er=`
  .wrapper {
    display: flex;
    align-items: center;
    border: 1px solid var(--ev-color-border);
    border-radius: var(--ev-radius-control, var(--ev-radius-md));
    background: var(--ev-color-surface-base);
    transition: border-color var(--ev-transition-fast),
                box-shadow var(--ev-transition-fast);
  }

  .wrapper:focus-within {
    border-color: var(--ev-color-border-focus);
    box-shadow: var(--ev-shadow-focus);
  }

  :host([disabled]) .wrapper {
    opacity: 0.5;
    cursor: not-allowed;
    background: var(--ev-color-bg-sunken);
  }
`,ht=`
  :host {
    --ev-control-height: var(--ev-control-height-md, var(--ev-size-md, 2rem));
    --ev-control-font-size: var(--ev-font-size-sm, 0.8125rem);
    --ev-control-icon-size: 16px;
    --ev-choice-size: 18px;
    --ev-choice-mark-size: 12px;
    --ev-choice-dot-size: 8px;
    --ev-choice-gap: var(--ev-space-2, 0.5rem);
    --ev-choice-font-size: var(--ev-font-size-sm, 0.8125rem);
  }

  :host([full-width]) {
    box-sizing: border-box;
    inline-size: 100%;
    max-inline-size: 100%;
    min-inline-size: 0;
  }

  :host([full-width]) [data-ev-root] {
    display: block;
    inline-size: 100%;
    min-inline-size: 0;
  }

  :host([full-width]) .wrapper,
  :host([full-width]) .trigger {
    inline-size: 100%;
  }

  :host([size="sm"]) {
    --ev-control-height: var(--ev-control-height-sm, var(--ev-size-sm, 1.5rem));
    --ev-control-padding-x: var(--ev-space-2, 0.5rem);
    --ev-control-padding-y: var(--ev-space-1, 0.25rem);
    --ev-control-font-size: var(--ev-font-size-xs, 0.75rem);
    --ev-control-icon-size: 14px;
    --ev-choice-size: 16px;
    --ev-choice-mark-size: 10px;
    --ev-choice-dot-size: 6px;
    --ev-choice-font-size: var(--ev-font-size-xs, 0.75rem);
  }

  :host([size="md"]),
  :host(:not([size])) {
    --ev-control-height: var(--ev-control-height-md, var(--ev-size-md, 2rem));
    --ev-control-font-size: var(--ev-font-size-sm, 0.8125rem);
    --ev-control-icon-size: 16px;
    --ev-choice-size: 18px;
    --ev-choice-mark-size: 12px;
    --ev-choice-dot-size: 8px;
    --ev-choice-font-size: var(--ev-font-size-sm, 0.8125rem);
  }

  :host([size="lg"]) {
    --ev-control-height: var(--ev-control-height-lg, var(--ev-size-lg, 2.5rem));
    --ev-control-padding-x: var(--ev-space-4, 1rem);
    --ev-control-padding-y: var(--ev-space-3, 0.75rem);
    --ev-control-font-size: var(--ev-font-size-base, 1rem);
    --ev-control-icon-size: 18px;
    --ev-choice-size: 20px;
    --ev-choice-mark-size: 14px;
    --ev-choice-dot-size: 10px;
    --ev-choice-font-size: var(--ev-font-size-base, 1rem);
  }
`,tr=`
  :host([size="sm"]) .wrapper {
    min-height: var(--ev-control-height);
    padding: 0 var(--ev-control-padding-x, var(--ev-space-3, 0.75rem));
    font-size: var(--ev-control-font-size);
  }
  :host([size="md"]) .wrapper,
  :host(:not([size])) .wrapper {
    min-height: var(--ev-control-height);
    padding: 0 var(--ev-control-padding-x, var(--ev-space-3, 0.75rem));
    font-size: var(--ev-control-font-size);
  }
  :host([size="lg"]) .wrapper {
    min-height: var(--ev-control-height);
    padding: 0 var(--ev-control-padding-x, var(--ev-space-3, 0.75rem));
    font-size: var(--ev-control-font-size);
  }
`,is={default:"neutral",primary:"brand",secondary:"neutral",error:"danger"},rr={neutral:{accent:"var(--ev-color-secondary)",solidBg:"var(--ev-color-secondary)",solidBgHover:"var(--ev-color-secondary-hover)",solidBgActive:"var(--ev-color-secondary-hover)",solidBorder:"var(--ev-color-secondary)",solidBorderHover:"var(--ev-color-secondary-hover)",solidBorderActive:"var(--ev-color-secondary-hover)",subtleBg:"var(--ev-color-secondary-subtle)",subtleBorder:"var(--ev-color-border)",subtleHover:"var(--ev-color-bg-sunken)",subtleColor:"var(--ev-color-text-secondary)",textOn:"var(--ev-color-text-inverse)"},brand:{accent:"var(--ev-color-brand)",solidBg:"var(--ev-color-brand)",solidBgHover:"var(--ev-color-brand-hover)",solidBgActive:"var(--ev-color-brand-active)",solidBorder:"var(--ev-color-brand)",solidBorderHover:"var(--ev-color-brand-hover)",solidBorderActive:"var(--ev-color-brand-active)",subtleBg:"var(--ev-color-brand-subtle)",subtleBorder:"var(--ev-color-brand-muted)",subtleHover:"var(--ev-color-brand-muted)",subtleColor:"var(--ev-color-brand)",textOn:"var(--ev-color-text-on-brand, var(--ev-color-text-on-primary))"},success:{accent:"var(--ev-color-success)",solidBg:"var(--ev-color-success)",solidBgHover:"var(--ev-color-success-hover)",solidBgActive:"var(--ev-color-success-active)",solidBorder:"var(--ev-color-success)",solidBorderHover:"var(--ev-color-success-hover)",solidBorderActive:"var(--ev-color-success-active)",subtleBg:"var(--ev-color-success-subtle)",subtleBorder:"var(--ev-color-success-muted)",subtleHover:"var(--ev-color-success-muted)",subtleColor:"var(--ev-color-success)",textOn:"var(--ev-color-text-on-success, var(--ev-color-text-on-primary))"},info:{accent:"var(--ev-color-info)",solidBg:"var(--ev-color-info)",solidBgHover:"var(--ev-color-info-hover)",solidBgActive:"var(--ev-color-info-active)",solidBorder:"var(--ev-color-info)",solidBorderHover:"var(--ev-color-info-hover)",solidBorderActive:"var(--ev-color-info-active)",subtleBg:"var(--ev-color-info-subtle)",subtleBorder:"var(--ev-color-info-muted)",subtleHover:"var(--ev-color-info-muted)",subtleColor:"var(--ev-color-info)",textOn:"var(--ev-color-text-on-info, var(--ev-color-text-on-primary))"},warning:{accent:"var(--ev-color-warning)",solidBg:"var(--ev-color-warning)",solidBgHover:"var(--ev-color-warning-hover)",solidBgActive:"var(--ev-color-warning-active)",solidBorder:"var(--ev-color-warning)",solidBorderHover:"var(--ev-color-warning-hover)",solidBorderActive:"var(--ev-color-warning-active)",subtleBg:"var(--ev-color-warning-subtle)",subtleBorder:"var(--ev-color-warning-muted)",subtleHover:"var(--ev-color-warning-muted)",subtleColor:"var(--ev-color-warning)",textOn:"var(--ev-color-text-on-warning, var(--ev-color-text-on-primary))"},caution:{accent:"var(--ev-color-caution)",solidBg:"var(--ev-color-caution)",solidBgHover:"var(--ev-color-caution-hover)",solidBgActive:"var(--ev-color-caution-active)",solidBorder:"var(--ev-color-caution)",solidBorderHover:"var(--ev-color-caution-hover)",solidBorderActive:"var(--ev-color-caution-active)",subtleBg:"var(--ev-color-caution-subtle)",subtleBorder:"var(--ev-color-caution-muted)",subtleHover:"var(--ev-color-caution-muted)",subtleColor:"var(--ev-color-caution-active)",textOn:"var(--ev-color-text-on-caution, var(--ev-color-text-primary))"},danger:{accent:"var(--ev-color-danger)",solidBg:"var(--ev-color-danger)",solidBgHover:"var(--ev-color-danger-hover)",solidBgActive:"var(--ev-color-danger-active)",solidBorder:"var(--ev-color-danger)",solidBorderHover:"var(--ev-color-danger-hover)",solidBorderActive:"var(--ev-color-danger-active)",subtleBg:"var(--ev-color-danger-subtle)",subtleBorder:"var(--ev-color-danger-muted)",subtleHover:"var(--ev-color-danger-muted)",subtleColor:"var(--ev-color-danger)",textOn:"var(--ev-color-text-on-danger, var(--ev-color-text-on-primary))"},premium:{accent:"var(--ev-color-premium)",solidBg:"var(--ev-color-premium)",solidBgHover:"var(--ev-color-premium-hover)",solidBgActive:"var(--ev-color-premium-active)",solidBorder:"var(--ev-color-premium)",solidBorderHover:"var(--ev-color-premium-hover)",solidBorderActive:"var(--ev-color-premium-active)",subtleBg:"var(--ev-color-premium-subtle)",subtleBorder:"var(--ev-color-premium-muted)",subtleHover:"var(--ev-color-premium-muted)",subtleColor:"var(--ev-color-premium)",textOn:"var(--ev-color-text-on-premium, var(--ev-color-text-on-primary))"},niche:{accent:"var(--ev-color-niche)",solidBg:"var(--ev-color-niche)",solidBgHover:"var(--ev-color-niche-hover)",solidBgActive:"var(--ev-color-niche-active)",solidBorder:"var(--ev-color-niche)",solidBorderHover:"var(--ev-color-niche-hover)",solidBorderActive:"var(--ev-color-niche-active)",subtleBg:"var(--ev-color-niche-subtle)",subtleBorder:"var(--ev-color-niche-muted)",subtleHover:"var(--ev-color-niche-muted)",subtleColor:"var(--ev-color-niche)",textOn:"var(--ev-color-text-on-niche, var(--ev-color-text-on-primary))"},accent:{accent:"var(--ev-color-accent)",solidBg:"var(--ev-color-accent)",solidBgHover:"var(--ev-color-accent-hover)",solidBgActive:"var(--ev-color-accent-active)",solidBorder:"var(--ev-color-accent)",solidBorderHover:"var(--ev-color-accent-hover)",solidBorderActive:"var(--ev-color-accent-active)",subtleBg:"var(--ev-color-accent-subtle)",subtleBorder:"var(--ev-color-accent-muted)",subtleHover:"var(--ev-color-accent-muted)",subtleColor:"var(--ev-color-accent)",textOn:"var(--ev-color-text-on-accent, var(--ev-color-text-on-primary))"}};function Ee(s,e="neutral"){const t=String(s||"").trim().toLowerCase();if(!t)return e;const r=is[t]??t;return r in rr?r:e}function Te(s,e="neutral"){return rr[Ee(s,e)]}function ie(s){return Object.entries(s).filter(([,e])=>!!e).map(([e,t])=>`${e}:${t}`).join(";")}const zt=10;function de(s){const e=s.trim();return e?/^-?\d+(\.\d+)?$/.test(e)?`${e}px`:e:"0px"}class ut extends A{static MAIN_MIN=48;static props={sidebarLeftWidth:{type:"string",reflect:!0,default:"240px"},sidebarLeftMin:{type:"number",reflect:!0,default:120},sidebarLeftMax:{type:"number",reflect:!0,default:600},sidebarLeftResizable:{type:"boolean",reflect:!0,default:!0},sidebarRightWidth:{type:"string",reflect:!0,default:"300px"},sidebarRightMin:{type:"number",reflect:!0,default:120},sidebarRightMax:{type:"number",reflect:!0,default:600},sidebarRightResizable:{type:"boolean",reflect:!0,default:!0},stateId:{type:"string",reflect:!0,default:""}};_persistence=null;static styles=R`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100vh;
      overflow: hidden;
      background: var(--ev-shell-bg, var(--ev-color-bg));
      color: var(--ev-shell-color, var(--ev-color-text-primary));
      font-family: var(--ev-font-family);
    }

    .header {
      flex-shrink: 0;
      z-index: var(--ev-z-sticky);
    }

    .body {
      flex: 1;
      display: flex;
      overflow: hidden;
      min-height: 0;
    }

    .sidebar-left,
    .sidebar-right {
      display: block;
      flex-shrink: 0;
      overflow: hidden;
      transition: width var(--ev-transition-base), border-color var(--ev-transition-base);
    }

    .sidebar-left {
      border-inline-end: 1px solid var(--ev-color-border);
    }

    .sidebar-right {
      border-inline-start: 1px solid var(--ev-color-border);
    }

    .sidebar-left--collapsed {
      border-inline-end-color: transparent;
    }

    .sidebar-right--collapsed {
      border-inline-start-color: transparent;
    }

    .sidebar-left.dragging,
    .sidebar-right.dragging {
      transition: none;
    }

    .sidebar-left-inner {
      height: 100%;
      min-width: var(--ev-sidebar-left-w, 240px);
    }

    .sidebar-right-inner {
      height: 100%;
      min-width: var(--ev-sidebar-right-w, 300px);
    }

    .splitter {
      flex-shrink: 0;
      width: var(--ev-shell-splitter-size, 4px);
      cursor: col-resize;
      background: transparent;
      position: relative;
      z-index: 1;
      transition: background var(--ev-transition-fast);
    }

    .splitter::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: -2px;
      right: -2px;
    }

    .splitter:hover,
    .splitter:focus-visible,
    .splitter--active {
      background: var(--ev-shell-splitter-color, var(--ev-color-primary));
    }

    .splitter:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px var(--ev-shell-splitter-color, var(--ev-color-primary));
    }

    .splitter--hidden {
      display: none;
    }

    .main {
      display: block;
      flex: 1;
      overflow: auto;
      min-width: 0;
    }

    .footer {
      flex-shrink: 0;
      z-index: var(--ev-z-sticky);
    }
  `;render(){const e=this._hasSlottedContent("left"),t=this._hasSlottedContent("right"),r=de(this.sidebarLeftWidth),i=de(this.sidebarRightWidth),n=`width: ${r}`,a=`width: ${i}`,o=!e,c=!t||i==="0px",l=!e||!this.sidebarLeftResizable,d=!this.sidebarRightResizable||c;return _`
      <header class="header"><slot name="header"></slot></header>
      <div class="body">
        <aside class="sidebar-left" style="${n}; --ev-sidebar-left-w: ${r}${o?"; display:none":""}">
          <div class="sidebar-left-inner">
            <slot name="sidebar-left"></slot>
            <slot name="sidebar"></slot>
          </div>
        </aside>
        <div class="splitter${l?" splitter--hidden":""}" data-splitter="left"
             role="separator" aria-orientation="vertical"
             aria-label="Resize left sidebar" tabindex="0"></div>
        <main class="main"><slot name="main"></slot></main>
        <div class="splitter${d?" splitter--hidden":""}" data-splitter="right"
             role="separator" aria-orientation="vertical"
             aria-label="Resize right sidebar" tabindex="0"></div>
        <aside class="sidebar-right" style="${a}; --ev-sidebar-right-w: ${i}${c?"; display:none":""}">
          <div class="sidebar-right-inner">
            <slot name="sidebar-right"></slot>
          </div>
        </aside>
      </div>
      <footer class="footer"><slot name="footer"></slot></footer>
    `}onConnect(){this.addEventListener("ev-sidebar-collapse",this._onSidebarStateChange),this.addEventListener("ev-sidebar-expand",this._onSidebarStateChange),this.addEventListener("ev-sidebar-panel-change",this._onSidebarStateChange),this.stateId&&(this._persistence=Yt(this,{stateId:`ev-shell:${this.stateId}`,capture:()=>({leftWidth:this.sidebarLeftWidth,rightWidth:this.sidebarRightWidth,leftCollapsed:this._isSideCollapsed("left"),rightCollapsed:this._isSideCollapsed("right")}),restore:e=>this._restorePersistedState(e),captureOn:["ev-shell-sidebar-resize","ev-sidebar-collapse","ev-sidebar-expand"]}))}onDisconnect(){this._persistence?.detach(),this._persistence=null,this.removeEventListener("ev-sidebar-collapse",this._onSidebarStateChange),this.removeEventListener("ev-sidebar-expand",this._onSidebarStateChange),this.removeEventListener("ev-sidebar-panel-change",this._onSidebarStateChange)}_restorePersistedState(e){const t=this._sanitizeWidth(e.leftWidth,this.sidebarLeftMin,this.sidebarLeftMax);t!==null&&(this.sidebarLeftWidth=t);const r=this._sanitizeWidth(e.rightWidth,this.sidebarRightMin,this.sidebarRightMax);r!==null&&(this.sidebarRightWidth=r),typeof e.leftCollapsed=="boolean"&&this._applyCollapsed("left",e.leftCollapsed),typeof e.rightCollapsed=="boolean"&&this._applyCollapsed("right",e.rightCollapsed),this._syncSidebarState()}_sanitizeWidth(e,t,r){if(typeof e!="string")return null;const i=parseFloat(de(e));return Number.isFinite(i)?`${Math.round(Math.max(t,Math.min(r,i)))}px`:null}_applyCollapsed(e,t){const r=e==="left"?["sidebar-left","sidebar"]:["sidebar-right"];for(const i of r)for(const n of Array.from(this.querySelectorAll(`[slot="${i}"]`)))t?n.setAttribute("collapsed",""):n.removeAttribute("collapsed")}bindEvents(){this._bindSplitter("left"),this._bindSplitter("right"),this._syncSplitterAria("left"),this._syncSplitterAria("right");const e=this.queryAll("slot");for(const t of Array.from(e))t.addEventListener("slotchange",()=>this._syncSidebarState())}_onSidebarStateChange=()=>{X(()=>this._syncSidebarState())};_syncSidebarState(){this._syncSide("left"),this._syncSide("right")}_syncSide(e){const t=this.query(`.sidebar-${e}`),r=this.query(`[data-splitter="${e}"]`);if(!t)return;if(!this._hasSlottedContent(e)){t.classList.add(`sidebar-${e}--collapsed`),t.style.width="0",t.style.display="none",r&&r.classList.add("splitter--hidden");return}t.style.display="";const n=this._isSideCollapsed(e),a=`sidebar-${e}--collapsed`;if(n)t.classList.add(a),t.style.width="0";else{t.classList.remove(a);const o=de(e==="left"?this.sidebarLeftWidth:this.sidebarRightWidth);t.style.width=o}if(r){const o=e==="left"?this.sidebarLeftResizable:this.sidebarRightResizable;n||!o?r.classList.add("splitter--hidden"):r.classList.remove("splitter--hidden")}}_hasSlottedContent(e){const t=e==="left"?["sidebar-left","sidebar"]:["sidebar-right"];for(const r of t){if(this.querySelector(`[slot="${r}"]`))return!0;const i=this.query(`slot[name="${r}"]`);if(i&&i.assignedElements().length>0)return!0}return!1}_isSideCollapsed(e){const t=e==="left"?["sidebar-left","sidebar"]:["sidebar-right"];for(const r of t){const i=this.query(`slot[name="${r}"]`);if(i){for(const n of i.assignedElements())if(n.hasAttribute("collapsed"))return!0}}return!1}_findSidebarWithToggle(e){const t=e==="left"?["sidebar-left","sidebar"]:["sidebar-right"];for(const r of t){const i=this.query(`slot[name="${r}"]`);if(i){for(const n of i.assignedElements())if(n instanceof HTMLElement&&"toggle"in n)return n}}return null}_syncSplitterAria(e,t){const r=this.query(`[data-splitter="${e}"]`);if(!r)return;const i=e==="left"?this.sidebarLeftMin:this.sidebarRightMin,n=e==="left"?this.sidebarLeftMax:this.sidebarRightMax;let a=t??this.query(`.sidebar-${e}`)?.getBoundingClientRect().width??parseInt(de(e==="left"?this.sidebarLeftWidth:this.sidebarRightWidth),10);Number.isFinite(a)||(a=i),r.setAttribute("aria-valuemin",String(i)),r.setAttribute("aria-valuemax",String(n)),r.setAttribute("aria-valuenow",String(Math.round(Math.max(i,Math.min(n,a)))))}_bindSplitter(e){const t=this.query(`[data-splitter="${e}"]`);t&&(t.addEventListener("pointerdown",r=>{r.button===0&&(r.preventDefault(),this._startDrag(e,t,r))}),t.addEventListener("dblclick",()=>{const r=this._findSidebarWithToggle(e);r&&"toggle"in r&&r.toggle()}),t.addEventListener("keydown",r=>{this._handleSplitterKeydown(e,r)}))}_startDrag(e,t,r){t.setPointerCapture(r.pointerId),t.classList.add("splitter--active");const i=this.query(`.sidebar-${e}`);if(!i)return;i.classList.add("dragging");const n=e==="left"?this.sidebarLeftMin:this.sidebarRightMin,a=e==="left"?this.sidebarLeftMax:this.sidebarRightMax,o=l=>{const d=this.query(".body").getBoundingClientRect(),h=getComputedStyle(this).direction==="rtl";let b=e==="left"!==h?l.clientX-d.left:d.right-l.clientX;const g=this.query(`.sidebar-${e==="left"?"right":"left"}`),w=g&&getComputedStyle(g).display!=="none"?g.getBoundingClientRect().width:0,p=d.width-w-ut.MAIN_MIN;b=Math.max(n,Math.min(a,p,b)),i.style.width=`${b}px`,this._syncSplitterAria(e,b),this.emit("ev-shell-sidebar-resize",{side:e,width:b})},c=()=>{t.classList.remove("splitter--active"),i.classList.remove("dragging"),t.removeEventListener("pointermove",o),t.removeEventListener("pointerup",c),t.removeEventListener("pointercancel",c);const l=i.getBoundingClientRect().width;this._commitSidebarWidth(e,l)};t.addEventListener("pointermove",o),t.addEventListener("pointerup",c),t.addEventListener("pointercancel",c)}_commitSidebarWidth(e,t){const r=`${Math.round(t)}px`,i=e==="left"?"sidebarLeftWidth":"sidebarRightWidth";this[i]!==r&&(this._propStore.set(i,r),this.setAttribute(e==="left"?"sidebar-left-width":"sidebar-right-width",r))}_handleSplitterKeydown(e,t){const r=this.query(`.sidebar-${e}`);if(!r)return;const i=e==="left"?this.sidebarLeftMin:this.sidebarRightMin,n=e==="left"?this.sidebarLeftMax:this.sidebarRightMax,a=getComputedStyle(this).direction==="rtl",o=e==="left"!==a?"ArrowRight":"ArrowLeft";let c=0;if(t.key==="ArrowRight"||t.key==="ArrowLeft")c=t.key===o?zt:-zt;else if(t.key==="Home")c=-n;else if(t.key==="End")c=n;else if(t.key==="Enter"||t.key===" "){t.preventDefault();const h=this._findSidebarWithToggle(e);h&&"toggle"in h&&h.toggle();return}else return;t.preventDefault();const l=r.getBoundingClientRect().width,d=Math.max(i,Math.min(n,l+c));r.classList.add("dragging"),r.style.width=`${d}px`,this._commitSidebarWidth(e,d),X(()=>{r.classList.remove("dragging")}),this._syncSplitterAria(e,d),this.emit("ev-shell-sidebar-resize",{side:e,width:d})}}I("ev-shell",ut);const ns={file:'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a1 1 0 0 0 1 1h4"/>',"file-text":'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a1 1 0 0 0 1 1h4"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/>',"file-plus":'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a1 1 0 0 0 1 1h4"/><line x1="12" x2="12" y1="11" y2="17"/><line x1="9" x2="15" y1="14" y2="14"/>',"file-code":'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a1 1 0 0 0 1 1h4"/><path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/>',folder:'<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',"folder-open":'<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',save:'<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',copy:'<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',clipboard:'<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',scissors:'<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',undo:'<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',redo:'<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',trash:'<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',replace:'<path d="M14 4c0-1.1.9-2 2-2"/><path d="M20 2c1.1 0 2 .9 2 2"/><path d="M22 8c0 1.1-.9 2-2 2"/><path d="M16 10c-1.1 0-2-.9-2-2"/><path d="m3 7 3 3-3 3"/><path d="M22 18c0 1.1-.9 2-2 2"/><path d="M16 20c-1.1 0-2-.9-2-2"/><path d="M16 14c0-1.1.9-2 2-2"/><path d="M22 14c1.1 0 2 .9 2 2"/><line x1="9" x2="22" y1="21" y2="21"/>',eye:'<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',"eye-off":'<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><line x1="2" x2="22" y1="2" y2="22"/>',maximize:'<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',minimize:'<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>',columns:'<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="12" x2="12" y1="3" y2="21"/>',"panel-left":'<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',"panel-right":'<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',"chevron-down":'<path d="m6 9 6 6 6-6"/>',"chevron-up":'<path d="m18 15-6-6-6 6"/>',"chevron-left":'<path d="m15 18-6-6 6-6"/>',"chevron-right":'<path d="m9 18 6-6-6-6"/>',"arrow-up":'<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',"arrow-down":'<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',plus:'<path d="M5 12h14"/><path d="M12 5v14"/>',minus:'<path d="M5 12h14"/>',menu:'<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',"more-horizontal":'<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',"more-vertical":'<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',settings:'<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',check:'<path d="M20 6 9 17l-5-5"/>',"check-circle":'<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>',"alert-circle":'<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',code:'<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',cpu:'<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',terminal:'<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',"refresh-cw":'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',"book-open":'<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 0 3-3h7z"/>',"edit-2":'<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',"trash-2":'<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',"folder-plus":'<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',"folder-minus":'<path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',"git-branch":'<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',"git-commit":'<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',mail:'<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',inbox:'<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',send:'<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',reply:'<polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>',"reply-all":'<polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 0 0-4-4H7"/>',forward:'<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',archive:'<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',star:'<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',flag:'<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',paperclip:'<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',user:'<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',tag:'<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',calendar:'<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',bell:'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',"alert-triangle":'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',"help-circle":'<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',"external-link":'<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',link:'<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',"wrap-text":'<line x1="3" x2="21" y1="6" y2="6"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><polyline points="16 16 14 18 16 20"/><line x1="3" x2="10" y1="18" y2="18"/>',indent:'<polyline points="3 8 7 12 3 16"/><line x1="21" x2="11" y1="12" y2="12"/><line x1="21" x2="11" y1="6" y2="6"/><line x1="21" x2="11" y1="18" y2="18"/>',sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',moon:'<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',zap:'<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',binary:'<rect x="14" y="14" width="4" height="6" rx="2"/><rect x="6" y="4" width="4" height="6" rx="2"/><path d="M6 20h4"/><path d="M14 10h4"/><path d="M6 14h2v6"/><path d="M14 4h2v6"/>',braces:'<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',hash:'<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',"key-round":'<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',regex:'<path d="M17 3v10"/><path d="m12.67 5.5 8.66 5"/><path d="m12.67 10.5 8.66-5"/><path d="M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z"/>',dices:'<rect width="12" height="12" x="2" y="10" rx="2" ry="2"/><path d="m17.92 14 3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6"/><path d="M6 18h.01"/><path d="M10 14h.01"/><path d="M15 6h.01"/><path d="M18 9h.01"/>',calculator:'<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="16" x2="16" y1="14" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/>',clock:'<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',globe:'<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',timer:'<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',play:'<polygon points="6 3 20 12 6 21 6 3"/>',hammer:'<path d="m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>',sparkles:'<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/><path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>'};function as(s){return ns[s]}class os extends A{static props={name:{type:"string",reflect:!0,default:""},size:{type:"string",reflect:!0,default:"md"},label:{type:"string",reflect:!0,default:""}};static styles=R`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      vertical-align: middle;
      line-height: 0;
      color: inherit;
    }

    :host([size="xs"]) { width: var(--ev-icon-size-xs, 14px); height: var(--ev-icon-size-xs, 14px); }
    :host([size="sm"]) { width: var(--ev-icon-size-sm, 16px); height: var(--ev-icon-size-sm, 16px); }
    :host([size="md"]),
    :host(:not([size])) { width: var(--ev-icon-size-md, 20px); height: var(--ev-icon-size-md, 20px); }
    :host([size="lg"]) { width: var(--ev-icon-size-lg, 24px); height: var(--ev-icon-size-lg, 24px); }
    :host([size="xl"]) { width: var(--ev-icon-size-xl, 32px); height: var(--ev-icon-size-xl, 32px); }

    svg {
      width: 100%;
      height: 100%;
      display: block;
      stroke-width: var(--ev-icon-stroke-width, 2);
    }
  `;render(){const e=as(this.name);if(!e)return _`<!-- unknown icon: ${this.name} -->`;const t=this.label?_`role="img" aria-label="${this.label}"`:_`aria-hidden="true"`;return _`
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        ${t}
      >${te(e)}</svg>
    `}}I("ev-icon",os);class ls extends A{static props={icon:{type:"string",reflect:!0,default:""},label:{type:"string",reflect:!0,default:""},variant:{type:"string",reflect:!0,default:"ghost"},size:{type:"string",reflect:!0,default:"md"},disabled:{type:"boolean",reflect:!0,default:!1}};_tipVisible=!1;_tipTimer=null;static styles=R`
    :host {
      display: inline-flex;
      position: relative;
    }

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      border-radius: var(--ev-button-radius, 2px);
      cursor: pointer;
      transition:
        background var(--ev-transition-fast),
        color var(--ev-transition-fast),
        border-color var(--ev-transition-fast),
        box-shadow var(--ev-transition-fast);
      padding: 0;
      color: var(--_icon-button-color, var(--ev-color-text-secondary));
      background: var(--_icon-button-bg, transparent);
      border-color: var(--_icon-button-border, transparent);
    }

    button:hover:not(:disabled) {
      background: var(--_icon-button-bg-hover, var(--_icon-button-bg, transparent));
      border-color: var(--_icon-button-border-hover, var(--_icon-button-border, transparent));
      color: var(--_icon-button-color-hover, var(--_icon-button-color, var(--ev-color-text-secondary)));
    }

    button:active:not(:disabled) {
      background: var(--_icon-button-bg-active, var(--_icon-button-bg-hover, var(--_icon-button-bg, transparent)));
      border-color: var(--_icon-button-border-active, var(--_icon-button-border-hover, var(--_icon-button-border, transparent)));
    }

    button:focus-visible {
      outline: none;
      box-shadow: var(--ev-shadow-focus);
    }

    button:disabled {
      cursor: not-allowed;
      background: var(--ev-color-bg-elevated);
      border-color: var(--ev-color-border);
      color: var(--ev-color-text-disabled);
    }

    :host([size="xs"]) button { width: var(--ev-icon-button-size, var(--ev-size-xs)); height: var(--ev-icon-button-size, var(--ev-size-xs)); }
    :host([size="sm"]) button { width: var(--ev-icon-button-size, var(--ev-size-sm)); height: var(--ev-icon-button-size, var(--ev-size-sm)); }
    :host([size="md"]) button,
    :host(:not([size])) button { width: var(--ev-icon-button-size, var(--ev-size-md)); height: var(--ev-icon-button-size, var(--ev-size-md)); }
    :host([size="lg"]) button { width: var(--ev-icon-button-size, var(--ev-size-lg)); height: var(--ev-icon-button-size, var(--ev-size-lg)); }

    .tip {
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      margin-bottom: 6px;
      padding: var(--ev-space-1) var(--ev-space-2);
      background: var(--ev-color-text-primary);
      color: var(--ev-color-bg);
      font-size: var(--ev-font-size-xs);
      font-family: var(--ev-font-family);
      border-radius: var(--ev-radius-sm);
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transition: opacity var(--ev-transition-fast);
      z-index: var(--ev-z-tooltip);
    }

    .tip--visible {
      opacity: 1;
    }
  `;getResolvedStyle(){const e=(this.variant||"ghost").toLowerCase();if(e==="ghost"||e==="text")return ie({"--_icon-button-bg":"transparent","--_icon-button-bg-hover":"var(--ev-color-secondary-subtle)","--_icon-button-bg-active":"var(--ev-color-bg-sunken)","--_icon-button-border":"transparent","--_icon-button-color":"var(--ev-color-text-secondary)","--_icon-button-color-hover":"var(--ev-color-text-primary)"});const t=Ee(e,"brand"),r=Te(t,"brand");return ie(t==="neutral"?{"--_icon-button-bg":"var(--ev-color-surface-base)","--_icon-button-bg-hover":"var(--ev-color-bg-elevated)","--_icon-button-bg-active":"var(--ev-color-bg-sunken)","--_icon-button-border":"var(--ev-color-border)","--_icon-button-border-hover":"var(--ev-color-border-strong)","--_icon-button-border-active":"var(--ev-color-border-strong)","--_icon-button-color":"var(--ev-color-text-primary)"}:{"--_icon-button-bg":r.solidBg,"--_icon-button-bg-hover":r.solidBgHover,"--_icon-button-bg-active":r.solidBgActive,"--_icon-button-border":r.solidBorder,"--_icon-button-border-hover":r.solidBorderHover,"--_icon-button-border-active":r.solidBorderActive,"--_icon-button-color":r.textOn})}get renderMode(){return"stable"}render(){return _`
      <button type="button" data-ref="btn">
        <ev-icon data-ref="icon"></ev-icon>
      </button>
      <span class="tip" role="tooltip" data-ref="tip" hidden></span>
    `}syncDom(){const e=this.ref("btn"),t=this.ref("icon"),r=this.ref("tip");if(!e||!t||!r)return;e.style.cssText=this.getResolvedStyle(),e.disabled=this.disabled,e.tabIndex=this.disabled||!this._rovingTabbable?-1:0;const i=this.label||this.getAttribute("aria-label")?.trim()||this.icon.replace(/-/g," ")||"Button";e.setAttribute("aria-label",i);const n=this.size==="xs"?"xs":this.size==="sm"?"sm":this.size==="lg"?"lg":"md";t.setAttribute("name",this.icon),t.setAttribute("size",n),r.hidden=!this.label,r.textContent=this.label,r.classList.toggle("tip--visible",this._tipVisible&&!!this.label)}bindEvents(){const e=this.ref("btn");e&&(this.listen(e,"mouseenter",this._showTip),this.listen(e,"mouseleave",this._hideTip),this.listen(e,"focusin",this._showTip),this.listen(e,"focusout",this._hideTip),this.listen(e,"click",t=>{if(this.disabled){t.stopPropagation();return}this.emit("ev-icon-button-click")}))}_setTip(e){this._tipVisible=e;const t=this.query(".tip");t&&t.classList.toggle("tip--visible",e)}_showTip=()=>{this._tipTimer===null&&(this._tipTimer=setTimeout(()=>{this._tipTimer=null,this._setTip(!0)},400))};_hideTip=()=>{this._tipTimer!==null&&(clearTimeout(this._tipTimer),this._tipTimer=null),this._setTip(!1)};onDisconnect(){this._tipTimer!==null&&(clearTimeout(this._tipTimer),this._tipTimer=null)}_rovingTabbable=!0;setRovingTabindex(e){this._rovingTabbable=e;const t=this.query("button");t&&(t.tabIndex=this.disabled||!e?-1:0)}focus(e){this.query("button")?.focus(e)}blur(){this.query("button")?.blur()}click(){this.query("button")?.click()}}I("ev-icon-button",ls);class cs extends A{static props={visible:{type:"boolean",reflect:!0,default:!1},placeholder:{type:"string",reflect:!0,default:""}};_commands=[];_filtered=[];_query="";_activeIndex=0;_recentIds=[];_offRegistryChange=null;_offLocale=null;_overlay=Pr(this,{close:()=>this.close(),closeOnOutsideClick:!1});static styles=R`
    :host {
      display: none;
      position: fixed;
      inset: 0;
      z-index: var(--ev-z-modal);
      font-family: var(--ev-font-family);
    }

    :host([visible]) {
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding-top: 15vh;
    }

    .backdrop {
      position: fixed;
      inset: 0;
      background: var(--ev-color-backdrop);
    }

    .palette {
      position: relative;
      width: 100%;
      max-width: 560px;
      max-height: var(--ev-command-palette-max-height, 440px);
      background: var(--ev-command-palette-bg, var(--ev-color-surface-base));
      border: var(--ev-command-palette-border, 1px solid var(--ev-color-border));
      border-radius: var(--ev-command-palette-radius, var(--ev-radius-overlay));
      box-shadow: var(--ev-shadow-xl, var(--ev-shadow-lg));
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .input-wrapper {
      display: flex;
      align-items: center;
      gap: var(--ev-space-2);
      padding: var(--ev-command-palette-input-padding, var(--ev-space-3) var(--ev-space-4));
      border-bottom: 1px solid var(--ev-color-border);
    }

    .search-icon {
      width: 18px;
      height: 18px;
      color: var(--ev-color-text-tertiary);
      flex-shrink: 0;
    }

    input {
      flex: 1;
      border: none;
      outline: none;
      background: transparent;
      color: var(--ev-color-text-primary);
      font-size: var(--ev-font-size-base);
      font-family: inherit;
      min-width: 0;
    }

    input::placeholder {
      color: var(--ev-color-text-tertiary);
    }

    .results {
      overflow-y: auto;
      flex: 1;
    }

    .group-label {
      padding: var(--ev-space-2) var(--ev-space-4) var(--ev-space-1);
      font-size: var(--ev-font-size-xs);
      font-weight: var(--ev-font-weight-semibold);
      color: var(--ev-color-text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .item {
      display: flex;
      align-items: center;
      gap: var(--ev-space-2);
      padding: var(--ev-space-2) var(--ev-space-4);
      cursor: pointer;
      transition: background var(--ev-transition-fast);
    }

    .item:hover,
    .item--active {
      background: var(--ev-state-selected-bg);
    }

    .item--disabled {
      cursor: default;
    }

    .item--disabled .item-label,
    .item--disabled .item-icon,
    .item--disabled .item-shortcut {
      color: var(--ev-color-text-disabled);
    }

    .item-icon {
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .item-label {
      flex: 1;
      font-size: var(--ev-font-size-sm);
      color: var(--ev-color-text-primary);
    }

    .item-shortcut {
      font-size: var(--ev-font-size-xs);
      color: var(--ev-color-text-tertiary);
    }

    .empty {
      padding: var(--ev-space-6) var(--ev-space-4);
      text-align: center;
      color: var(--ev-color-text-tertiary);
      font-size: var(--ev-font-size-sm);
    }

    .footer {
      display: flex;
      align-items: center;
      gap: var(--ev-space-4);
      padding: var(--ev-space-2) var(--ev-space-4);
      border-top: 1px solid var(--ev-color-border);
      font-size: var(--ev-font-size-xs);
      color: var(--ev-color-text-tertiary);
    }

    .footer kbd {
      display: inline-flex;
      align-items: center;
      padding: 0 var(--ev-space-1);
      border: 1px solid var(--ev-color-border);
      border-radius: var(--ev-radius-sm);
      font-size: var(--ev-font-size-xs);
      font-family: inherit;
      background: var(--ev-color-surface-sunken);
      min-width: 20px;
      height: 20px;
      justify-content: center;
    }
  `;registerCommand(e){const t=this._commands.findIndex(r=>r.id===e.id);t>=0?this._commands[t]=e:this._commands.push(e)}unregisterCommand(e){this._commands=this._commands.filter(t=>t.id!==e)}_restoreFocusTo=null;open(){let e=document.activeElement;for(;e?.shadowRoot?.activeElement;)e=e.shadowRoot.activeElement;this._restoreFocusTo=e instanceof HTMLElement&&e!==document.body?e:null,this._query="",this._filtered=this._getFiltered(""),this._activeIndex=this._firstEnabled(),this.visible=!0,this._overlay.opened(),this._offRegistryChange??=j.onDidChange(()=>{this._filtered=this._getFiltered(this._query),this._activeIndex=Math.min(this._activeIndex,Math.max(this._filtered.length-1,0)),this.update()}),this.update(),X(()=>{const t=this.query("input");t&&(t.value="",t.focus())})}close(){this._offRegistryChange?.(),this._offRegistryChange=null,this.visible=!1,this._overlay.closed(),this.update(),this._restoreFocusTo?.focus(),this._restoreFocusTo=null}_firstEnabled(){for(let e=0;e<this._filtered.length;e++)if(!this._filtered[e].disabled)return e;return this._filtered.length>0?0:-1}_mergedCommands(){const e=new Set(this._commands.map(r=>r.id)),t=j.getAll().filter(r=>!e.has(r.id)).map(r=>({id:r.id,label:r.label,group:r.group,icon:r.icon,shortcut:r.keybinding?Kr(r.keybinding):void 0,action:()=>{j.execute(r.id)},disabled:!j.isEnabled(r.id)}));return[...this._commands,...t]}_fuzzyScore(e,t){const r=e.toLowerCase(),i=t.toLowerCase();if(!i)return 0;let n=0,a=0,o=0;for(const c of i){let l=-1;for(let d=n;d<r.length;d+=1)if(r[d]===c){l=d;break}if(l===-1)return 0;l===n&&n>0?(o+=1,a+=2+o):(o=0,a+=1),(l===0||/[\s\-_/.]/.test(r[l-1]))&&(a+=4),a+=Math.max(0,2-l*.1),n=l+1}return a}_getFiltered(e){const t=this._mergedCommands();let r;if(e)r=t.map(a=>({cmd:a,score:Math.max(this._fuzzyScore(a.label,e),this._fuzzyScore(a.group??"",e)*.5)})).filter(a=>a.score>0).sort((a,o)=>o.score-a.score).map(a=>a.cmd);else{const n=this._recentIds.map(o=>t.find(c=>c.id===o)).filter(o=>o!==void 0),a=t.filter(o=>!this._recentIds.includes(o.id));r=[...n,...a]}const i=new Map;for(const n of r){const a=n.group??"",o=i.get(a)??[];o.push(n),i.set(a,o)}return[...i.values()].flat()}_executeItem(e){e.disabled||(this._recentIds=[e.id,...this._recentIds.filter(t=>t!==e.id)].slice(0,10),this.close(),this.emit("ev-command-palette-execute",{id:e.id,label:e.label}),e.action())}get renderMode(){return"stable"}render(){return _`
      <div class="backdrop" data-ref="backdrop"></div>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="input-wrapper">
          <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="text" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-controls="palette-results" aria-autocomplete="list" aria-label="Command search" data-ref="input" />
        </div>
        <div class="results" id="palette-results" role="listbox" data-ref="results"></div>
        <div class="footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> execute</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    `}_renderedResultsKey="";syncDom(){const e=this.ref("input"),t=this.ref("results");if(!e||!t)return;if(e.placeholder=this.placeholder||se("palette.placeholder"),e.setAttribute("aria-expanded",String(this.visible&&this._filtered.length>0)),!this.visible){t.innerHTML="",this._renderedResultsKey="",e.removeAttribute("aria-activedescendant");return}const r=JSON.stringify(this._filtered.map(i=>[i.id,i.disabled,i.label]));if(r!==this._renderedResultsKey){this._renderedResultsKey=r;const i=[];let n=null;this._filtered.forEach((a,o)=>{const c=a.group??"";c&&c!==n&&i.push(_`<div class="group-label">${c}</div>`),n=c;const l=a.icon?_`<span class="item-icon"><ev-icon name="${a.icon}" size="sm"></ev-icon></span>`:_`<span class="item-icon"></span>`,d=a.shortcut?_`<span class="item-shortcut">${a.shortcut}</span>`:"";i.push(_`
          <div class="item${a.disabled?" item--disabled":""}" id="palette-item-${o}" role="option" data-index="${o}" data-id="${a.id}" aria-disabled="${a.disabled?"true":"false"}" aria-selected="false">
            ${l}
            <span class="item-label">${a.label}</span>
            ${d}
          </div>`)}),t.innerHTML=String(this._filtered.length===0?_`<div class="empty">${se("palette.noResults")}</div>`:_`${i}`)}t.querySelectorAll(".item").forEach(i=>{const n=parseInt(i.dataset.index??"-1",10)===this._activeIndex;i.classList.toggle("item--active",n),i.setAttribute("aria-selected",String(n))}),this._activeIndex>=0&&this._filtered.length>0?e.setAttribute("aria-activedescendant",`palette-item-${this._activeIndex}`):e.removeAttribute("aria-activedescendant"),this._scrollActive()}bindEvents(){const e=this.ref("input"),t=this.ref("results"),r=this.ref("backdrop");r&&this.listen(r,"click",()=>this.close()),e&&(this.listen(e,"input",()=>{this._query=e.value,this._filtered=this._getFiltered(this._query),this._activeIndex=this._firstEnabled(),this.update()}),this.listen(e,"keydown",i=>{const n=i,a=n.key==="PageDown"?"ArrowDown":n.key==="PageUp"?"ArrowUp":null,o=a?8:1,c=a??n.key;if(["ArrowDown","ArrowUp","Home","End"].includes(c)){n.preventDefault();let l=this._activeIndex;for(let d=0;d<o;d++){const h=Qt(c,{count:this._filtered.length,activeIndex:l,orientation:"vertical",wrap:!a&&c!=="Home"&&c!=="End",rtl:!1,isDisabled:u=>!!this._filtered[u]?.disabled});if(h<0)break;l=h}l!==this._activeIndex&&(this._activeIndex=l,this.update())}else if(n.key==="Enter"){n.preventDefault();const l=this._filtered[this._activeIndex];l&&this._executeItem(l)}else n.key==="Tab"?n.preventDefault():n.key==="Escape"&&(n.preventDefault(),this.close())})),t&&this.listen(t,"click",i=>{const n=i.target.closest("[data-id]");if(!n)return;const a=n.dataset.id,o=this._filtered.find(c=>c.id===a);o&&this._executeItem(o)})}_scrollActive(){const e=this.query(".item--active");e&&e.scrollIntoView({block:"nearest"})}onConnect(){this._offLocale=Zt(()=>this.update()),this._handleGlobalKeydown=this._handleGlobalKeydown.bind(this),document.addEventListener("keydown",this._handleGlobalKeydown)}onDisconnect(){this._offLocale?.(),this._offLocale=null,document.removeEventListener("keydown",this._handleGlobalKeydown),this._offRegistryChange?.(),this._offRegistryChange=null,this._overlay.closed()}_handleGlobalKeydown(e){(e.metaKey||e.ctrlKey)&&e.key==="k"&&(e.preventDefault(),this.visible?this.close():this.open())}}I("ev-command-palette",cs);let ds=0;class hs extends A{_cid=`ev-accordion-item-${++ds}`;static props={heading:{type:"string",reflect:!0,default:""},expanded:{type:"boolean",reflect:!0,default:!1},disabled:{type:"boolean",reflect:!0,default:!1},fill:{type:"boolean",reflect:!0,default:!1}};static styles=R`
    :host {
      display: block;
      font-family: var(--ev-font-family);
      border-bottom: 1px solid var(--ev-color-border);
    }

    :host(:first-child) .header {
      border-radius: var(--ev-radius-md) var(--ev-radius-md) 0 0;
    }

    :host([disabled]) {
      opacity: var(--ev-state-disabled-opacity, 0.5);
      pointer-events: none;
    }

    .header {
      display: flex;
      align-items: center;
      gap: var(--ev-accordion-item-header-gap, var(--ev-space-2));
      padding: var(--ev-accordion-item-header-padding, var(--ev-space-3) var(--ev-space-4));
      background: var(--ev-accordion-item-header-bg, var(--ev-color-surface-raised));
      cursor: pointer;
      user-select: none;
      font-size: var(--ev-font-size-sm);
      font-weight: var(--ev-font-weight-medium);
      color: var(--ev-color-text-primary);
      transition: background var(--ev-transition-fast);
    }

    .header:hover {
      background: var(--ev-state-hover-bg);
    }

    .header:focus-visible {
      outline: none;
      box-shadow: var(--ev-shadow-focus);
      z-index: 1;
      position: relative;
    }

    .chevron {
      display: inline-flex;
      width: 14px;
      height: 14px;
      color: var(--ev-color-text-tertiary);
      transition: transform var(--ev-transition-fast);
      flex-shrink: 0;
    }

    .chevron svg { width: 100%; height: 100%; }

    .chevron--expanded {
      transform: rotate(0deg);
    }

    .chevron--collapsed {
      transform: rotate(-90deg);
    }

    .header-text { flex: 1; }

    .content {
      padding: var(--ev-accordion-item-content-padding, var(--ev-space-4));
      font-size: var(--ev-font-size-sm);
      color: var(--ev-color-text-secondary);
    }

    .content--hidden { display: none; }

    /* Fill mode: header fixed, body takes the allotted height and scrolls. */
    :host([fill]) {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    :host([fill]) .heading { flex: 0 0 auto; }

    :host([fill]) .content {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
    }

    :host([fill][expanded]) .content {
      animation: ev-accordion-reveal var(--ev-transition-base, 200ms ease-out);
    }

    @keyframes ev-accordion-reveal {
      from { opacity: 0; }
    }

    @media (prefers-reduced-motion: reduce) {
      :host([fill][expanded]) .content { animation: none; }
    }
  `;render(){const e=this.expanded?"chevron chevron--expanded":"chevron chevron--collapsed",t=this.expanded?"content":"content content--hidden",r='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',i=`${this._cid}-header`,n=`${this._cid}-panel`;return _`
      <div class="heading" role="heading" aria-level="3">
        <div class="header" id="${i}" tabindex="${this.disabled?"-1":"0"}" role="button"
          aria-expanded="${this.expanded}" aria-controls="${n}" aria-disabled="${String(this.disabled)}">
          <span class="${e}">${te(r)}</span>
          <span class="header-text">${this.heading}</span>
        </div>
      </div>
      <div class="${t}" id="${n}" role="region" aria-labelledby="${i}">
        <slot></slot>
      </div>
    `}bindEvents(){const e=this.query(".header");e&&(e.addEventListener("click",()=>this._toggle()),e.addEventListener("keydown",t=>{(t.key==="Enter"||t.key===" ")&&(t.preventDefault(),this._toggle())}))}_toggle(){if(this.disabled)return;const e=this.shadow.activeElement?.classList.contains("header")??!1;this.expanded=!this.expanded,this.emit("ev-accordion-toggle",{expanded:this.expanded}),this.update(),e&&X(()=>this.query(".header")?.focus())}}I("ev-accordion-item",hs);class us extends A{static props={multiple:{type:"boolean",reflect:!0,default:!1},fill:{type:"boolean",reflect:!0,default:!1}};static styles=R`
    :host {
      display: block;
      border: var(--ev-accordion-border, 1px solid var(--ev-color-border));
      border-radius: var(--ev-accordion-radius, var(--ev-radius-md));
      overflow: hidden;
    }

    /* Fill mode: occupy the parent's height; collapsed children keep their
       natural height, expanded items share whatever is left. */
    :host([fill]) {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }

    :host([fill]) ::slotted(*) { flex: 0 0 auto; }

    :host([fill]) ::slotted(ev-accordion-item[expanded]) {
      flex: 1 1 0;
      min-height: 0;
    }
  `;_observer=null;_resizeObserver=null;_tops=new Map;_animation=null;_slidePending=!1;onConnect(){this.addEventListener("ev-accordion-toggle",e=>{if(this.multiple)return;const t=e.target;t.expanded&&this._collapseOthers(t)}),this._observer=new MutationObserver(e=>this._onMutations(e)),this._observer.observe(this,{childList:!0,subtree:!0,attributes:!0,attributeFilter:["expanded"]}),this._resizeObserver=new ResizeObserver(()=>{this._animation||this._snapshot()}),this._resizeObserver.observe(this)}onDisconnect(){this._observer?.disconnect(),this._observer=null,this._resizeObserver?.disconnect(),this._resizeObserver=null,this._animation?.cancel(),this._animation=null,this._slidePending=!1,this._tops.clear()}onRender(){this._syncItemFill(),this.fill&&X(()=>this._snapshot())}render(){return _`<slot></slot>`}bindEvents(){this.query("slot")?.addEventListener("slotchange",()=>this._syncItemFill())}_items(){return Array.from(this.children).filter(e=>e.tagName.toLowerCase()==="ev-accordion-item")}_collapseOthers(e){for(const t of this._items())t!==e&&t.expanded&&(t.expanded=!1)}_syncItemFill(){for(const e of this._items())e.fill!==this.fill&&(e.fill=this.fill)}_onMutations(e){let t=!1;for(const r of e){if(r.type==="childList"){r.target===this&&(t=!0,this._syncItemFill());continue}const i=r.target;if(i.parentElement!==this||i.tagName.toLowerCase()!=="ev-accordion-item")continue;t=!0;const n=i;!this.multiple&&n.expanded&&this._collapseOthers(n)}t&&this.fill&&this._slide()}_snapshot(){const e=this.getBoundingClientRect().top;this._tops.clear();for(const t of Array.from(this.children))this._tops.set(t,t.getBoundingClientRect().top-e)}_slide(){this._slidePending||(this._slidePending=!0,X(()=>{this._slidePending=!1,this._animation?.cancel();const e=new Map(this._tops);if(this._snapshot(),globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches)return;const t=[];for(const o of Array.from(this.children)){const c=e.get(o),l=this._tops.get(o);c===void 0||l===void 0||Math.abs(c-l)<.5||(t.push({el:o,transform:o.style.transform,transition:o.style.transition}),o.style.transition="none",o.style.transform=`translateY(${c-l}px)`)}if(t.length===0)return;this.offsetHeight;for(const o of t)o.el.style.transition="transform var(--ev-transition-base, 200ms ease-out)",o.el.style.transform=o.transform;const r=t[0].el,i=o=>{o.target===r&&o.propertyName==="transform"&&n()},n=()=>{clearTimeout(a),r.removeEventListener("transitionend",i);for(const o of t)o.el.style.transition=o.transition,o.el.style.transform=o.transform;this._animation=null},a=setTimeout(n,400);r.addEventListener("transitionend",i),this._animation={cancel:n}}))}}I("ev-accordion",us);const Ye="osca-portal:session",vs="/api/admin/login";function ps(){try{return JSON.parse(sessionStorage.getItem(Ye)??"null")}catch{return null}}function Re(s){try{s?sessionStorage.setItem(Ye,JSON.stringify(s)):sessionStorage.removeItem(Ye)}catch{}}let T=ps(),Y=!1;const Ze=new Set;function sr(s,e){const t=typeof s.exp=="number"?s.exp*1e3:Date.now()+3e5;return{access:s.access_token,refresh:s.refresh_token,exp:t,user:s.sub??e}}class ee extends Error{}async function fs(s,e,t=""){let r;try{r=await fetch(vs,{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify(t?{user:s,password:e,role:t}:{user:s,password:e})})}catch{throw new ee("Can’t reach the IRIS server. Check that the instance is running.")}if(r.status===401)throw new ee("That username and password didn’t work.");if(r.status===404)throw new ee("This IRIS instance has no sign-in endpoint. OSCA Portal needs IRIS 2026.2 or later.");if(!r.ok)throw new ee(`Sign-in failed: HTTP ${r.status} ${r.statusText}`);const i=await r.json();if(!i.result?.access_token)throw new ee("Sign-in succeeded but IRIS returned no token.");Y=!1,T=sr(i.result,s),Re(T)}let We=null;function At(){return T?(We??=(async()=>{try{const s=await fetch("/api/admin/refresh",{method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({refresh_token:T?.refresh})});if(!s.ok)return!1;const e=await s.json();return!e.result?.access_token||!T?!1:(T=sr({...e.result,refresh_token:e.result.refresh_token??T.refresh},T.user),Re(T),!0)}catch{return!1}finally{We=null}})(),We):Promise.resolve(!1)}function Lt(s={}){if(!T)return s;const e=new Headers(s.headers);return e.set("Authorization",`Bearer ${T.access}`),{...s,headers:e}}async function Q(s,e={}){T&&T.exp-Date.now()<3e4&&await At();let t=await fetch(s,Lt(e));if(s.startsWith("/api/monitor"))return t.status===401&&T&&(t=await fetch(s,e)),t;if(t.status===401&&T&&await At()&&(t=await fetch(s,Lt(e))),t.status===401&&!Y){T=null,Re(null);for(const r of Ze)r()}return t}async function Et(){const s=T;if(T=null,Y=!1,Re(null),!s)return;const e={"Content-Type":"application/json",Authorization:`Bearer ${s.access}`};await Promise.allSettled([fetch("/api/admin/logout",{method:"POST",headers:e,body:JSON.stringify({refresh_token:s.refresh})}),fetch("/api/admin/revoke",{method:"POST",headers:e})])}async function bs(){try{return(await fetch("/api/admin/info",{headers:{Accept:"application/json"}})).ok}catch{return!1}}const G={get signedIn(){return T!==null||Y},get user(){return T?.user??(Y?"Not signed in":"")},get anonymous(){return Y},continueAnonymously(){Y=!0},onExpired(s){return Ze.add(s),()=>Ze.delete(s)}},ms="/api/admin/v2";async function oe(s){const e=await Q(`${ms}${s}`,{headers:{Accept:"application/json"}});if(!e.ok)throw new Error(`Admin API ${s} → HTTP ${e.status} ${e.statusText}`);const t=await e.json();if(t.status?.errors?.length)throw new Error(t.status.errors[0]?.error||t.status.summary||"Admin API error");return t.result}const gs=()=>oe("/monitor/dashboard/main");function ys(){return Q("/api/admin/info",{headers:{Accept:"application/json"}}).then(s=>s.json()).then(s=>s.result)}const ir=()=>oe("/processes"),_s=()=>oe("/security/users"),ws=()=>oe("/web-apps"),nr=()=>oe("/task/upcoming"),xs=()=>oe("/namespaces");async function ks(){const s=await Q("/api/monitor/alerts",{headers:{Accept:"application/json"}});if(!s.ok)throw new Error(`Monitor API /alerts → HTTP ${s.status} ${s.statusText}`);return await s.json()}const ar=1e4,Ss=ar,$s=30;function Cs(s){const e=new Map;for(const t of s.split(`
`)){if(!t||t.startsWith("#"))continue;const r=/^([a-zA-Z_:][\w:]*)(\{(.*)\})?\s+(\S+)/.exec(t);if(!r)continue;const i={};if(r[3])for(const o of r[3].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g))i[o[1]]=o[2].replace(/\\\\/g,"\\").replace(/\\"/g,'"');const n=Number(r[4]),a=e.get(r[1])??[];a.push({labels:i,value:n}),e.set(r[1],a)}return e}const Tt=(s,e={})=>`${s}${JSON.stringify(Object.entries(e).sort())}`;class Ms{latest=null;latestAt=null;history=new Map;listeners=new Set;errorListeners=new Set;timer=null;inflight=null;subscribe(e,t){return this.listeners.add(e),t&&this.errorListeners.add(t),this.latest&&this.latestAt&&e(this.latest,this.latestAt),this.timer||(this.poll(),this.timer=setInterval(()=>void this.poll(),Ss)),()=>{this.listeners.delete(e),t&&this.errorListeners.delete(t),this.listeners.size===0&&this.timer&&(clearInterval(this.timer),this.timer=null)}}refresh(){return this.poll()}poll(){return this.inflight?this.inflight:(this.inflight=(async()=>{try{const e=await Q("/api/monitor/metrics",{headers:{Accept:"text/plain"}});if(!e.ok)throw new Error(`Monitor API /metrics → HTTP ${e.status} ${e.statusText}`);const t=Cs(await e.text());for(const[r,i]of t)for(const n of i){const a=Tt(r,n.labels),o=this.history.get(a)??[];o.push(n.value),o.length>$s&&o.shift(),this.history.set(a,o)}this.latest=t,this.latestAt=new Date;for(const r of this.listeners)r(t,this.latestAt)}catch(e){for(const t of this.errorListeners)t(e)}finally{this.inflight=null}})(),this.inflight)}trend(e,t={}){return[...this.history.get(Tt(e,t))??[]]}}const N=new Ms;function C(s,e,t={}){const r=s.get(e)?.find(i=>Object.entries(t).every(([n,a])=>i.labels[n]===a));return r?r.value:NaN}function Xe(s,e){return N.trend(e,s.get(e)?.[0]?.labels??{})}function D(s,e){return s.get(e)??[]}function Qe(s){switch(s){case 0:return{label:"Healthy",tone:"success"};case 1:return{label:"Warning",tone:"warning"};case 2:return{label:"Alert",tone:"danger"};case-1:return{label:"Hung",tone:"danger"};default:return{label:"Unknown",tone:"neutral"}}}const or="osca-portal:alerts",zs=500,As=3e4;function Ls(){try{return JSON.parse(localStorage.getItem(or)??"[]")}catch{return[]}}function lr(s){try{localStorage.setItem(or,JSON.stringify(s))}catch{}}let q=Ls();const Ce=new Set;let Rt=null;async function Fe(){try{const s=await ks();if(s.length===0)return;const e=new Set(q.map(r=>r.time+r.message)),t=s.filter(r=>!e.has(r.time+r.message));if(t.length===0)return;q=[...t,...q].sort((r,i)=>i.time.localeCompare(r.time)).slice(0,zs),lr(q);for(const r of Ce)r(q)}catch{}}const ne={subscribe(s){return Ce.add(s),s(q),Rt||(Fe(),Rt=setInterval(()=>void Fe(),As)),()=>{Ce.delete(s)}},refresh:Fe,count:()=>q.length,clear(){q=[],lr(q);for(const s of Ce)s(q)}};function et(s){switch(Number(s)){case 0:return{label:"Info",tone:"info"};case 1:return{label:"Warning",tone:"warning"};case 3:return{label:"Fatal",tone:"danger"};default:return{label:"Severe",tone:"danger"}}}const Es=5e3;let be=null,me=null;const ge=new Set;let he=null;async function It(){try{const s=await ir(),e=performance.now(),t=new Map(s.map(r=>[r.Pid,r.CPUTime]));if(be){const r=(e-be.at)/1e3,i=be.byPid,n=new Map(s.map(a=>[a.Pid,i.has(a.Pid)?Math.max(0,(a.CPUTime-(i.get(a.Pid)??0))/1e3/r*100):0]));me={procs:s,pct:n,total:[...n.values()].reduce((a,o)=>a+o,0),secs:r};for(const a of ge)a(me)}be={at:e,byPid:t}}catch(s){for(const e of ge)e(null,s)}}const cr={subscribe(s){return ge.add(s),me&&s(me),he||(It(),he=setInterval(()=>void It(),Es)),()=>{ge.delete(s),ge.size===0&&he&&(clearInterval(he),he=null,be=null,me=null)}}},dr=s=>s===null?"whole machine":`IRIS ${s.toFixed(1)}% of one core`;function x(s){return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}function B(s){if(!Number.isFinite(s))return"—";const e=Math.abs(s);return e>=1e9?`${(s/1e9).toFixed(1)}B`:e>=1e6?`${(s/1e6).toFixed(1)}M`:e>=1e4?`${(s/1e3).toFixed(1)}K`:Math.round(s).toLocaleString()}function O(s){return Number.isFinite(s)?s>=1024*1024?`${(s/1024/1024).toFixed(1)} TB`:s>=1024?`${(s/1024).toFixed(1)} GB`:s>=1?`${s.toFixed(s>=100?0:1)} MB`:`${Math.round(s*1024)} KB`:"—"}function P(s,e=0){return Number.isFinite(s)?`${s.toFixed(e)}%`:"—"}function hr(s){const e=s.split(":").map(Number);if(e.length!==3||e.some(r=>!Number.isFinite(r)))return s;const t=e[0]*3600+e[1]*60+e[2];return vt(t)}function vt(s){if(!Number.isFinite(s))return"—";const e=Math.floor(s/86400),t=Math.floor(s%86400/3600),r=Math.floor(s%3600/60),i=Math.floor(s%60);return e>0?`${e}d ${t}h`:t>0?`${t}h ${r}m`:r>0?`${r}m ${i}s`:`${i}s`}function ur(s,e=new Date){const t=Math.round((s.getTime()-e.getTime())/1e3);if(Math.abs(t)<45)return t>=0?"in a moment":"just now";const r=vt(Math.abs(t));return t>0?`in ${r}`:`${r} ago`}function Ts(s){return new Date(s.replace(" ","T"))}function _e(s,e="neutral",t=""){return`<ev-chip size="sm" tone="${e}"${t?` title="${x(t)}"`:""}>${x(s)}</ev-chip>`}const Se="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;",E={mono:(s,e=!1,t="")=>`<span style="${Se}font-family:var(--ev-font-family-mono);font-size:var(--ev-font-size-xs);color:var(--ev-color-text-${e?"secondary":"primary"})"${t?` title="${x(t)}"`:""}>${x(s)}</span>`,text:(s,e="")=>`<span style="${Se}"${e?` title="${x(e)}"`:""}>${x(s)}</span>`,num:(s,e="")=>`<span style="${Se}font-variant-numeric:tabular-nums"${e?` title="${x(e)}"`:""}>${x(s)}</span>`,dim:s=>`<span style="${Se}color:var(--ev-color-text-tertiary)">${x(s)}</span>`,wrap:s=>`<span style="white-space:normal;line-height:1.45">${x(s)}</span>`};function W(s,e,t){return`<div class="stat" data-stat="${s}" data-kind="${t}">
    <div class="stat-label"><span class="stat-dot"></span>${x(e)}</div>
    <div class="stat-line"><span class="stat-value">—</span><span class="stat-caption"></span></div>
    ${t==="bar"?'<div class="bar stat-bar"><span></span></div>':""}
    ${t==="trend"?'<ev-sparkline class="stat-trend" type="line" height="18" min="0"></ev-sparkline>':""}
  </div>`}function F(s,e,t){const r=s.querySelector(`[data-stat="${e}"]`);if(!r)return;r.dataset.tone=t.tone??"neutral",r.querySelector(".stat-value").textContent=t.value,r.querySelector(".stat-caption").textContent=t.caption??"",t.title&&(r.title=t.title);const i=r.querySelector(".stat-bar span");i&&t.fill!==void 0&&(i.style.width=`${Math.max(0,Math.min(100,t.fill))}%`);const n=r.querySelector(".stat-trend");if(n&&t.trend){const a=t.trend.length>=3&&Math.max(...t.trend)!==Math.min(...t.trend);n.hidden=!a,a&&(n.values=t.trend)}}function tt(s,e=30){if(s.length<=e)return s;const t=e-1;return`${s.slice(0,Math.ceil(t*.6))}…${s.slice(-Math.floor(t*.4))}`}function Z(s=6){return`<div class="skeleton-list" role="status" aria-label="Loading">${Array.from({length:s},()=>'<ev-skeleton shape="text" lines="1"></ev-skeleton>').join("")}</div>`}function ye(s,e){const t=s instanceof Error?s.message:String(s);return`<div class="panel-error" role="alert">
    <ev-icon name="alert-triangle" size="sm"></ev-icon>
    <div><strong>Couldn't load this data.</strong><span>${x(t)}</span></div>
    ${e?`<button type="button" class="btn" id="${e}">Try again</button>`:'<span class="dim">Retrying automatically…</span>'}
  </div>`}function Ie(s,e){s.actions.innerHTML=`
    <span class="live" title="This page refreshes automatically"><span class="live-dot"></span><span class="live-text">Live</span></span>
    <ev-icon-button icon="refresh-cw" label="Refresh now"></ev-icon-button>`;const t=s.actions.querySelector(".live-text");s.actions.querySelector("ev-icon-button")?.addEventListener("click",e);let r=null;const i=()=>{if(!r)return;const a=Math.round((Date.now()-r.getTime())/1e3);t.textContent=a<3?"Live · just updated":`Live · updated ${vt(a)} ago`},n=setInterval(i,1e3);return s.onLeave(()=>clearInterval(n)),a=>{r=a,i()}}const ue=(s,e,t)=>s>=t?"danger":s>=e?"warning":"success";function Rs(s){s.body.innerHTML=`
    <section class="stats stats--5">
      ${W("cpu","System CPU","trend")}
      ${W("mem","Memory","bar")}
      ${W("disk","Disk","bar")}
      ${W("procs","Processes","trend")}
      ${W("lic","License units","bar")}
    </section>
    <div class="columns">
      <div class="column column--wide">
        <section class="card">
          <header class="card-head"><h2>Needs attention</h2><span class="card-hint" id="attention-count"></span></header>
          <div id="attention">${Z(3)}</div>
        </section>
        <section class="card">
          <header class="card-head"><h2>Busiest right now</h2><button type="button" class="link" data-go="operations/processes">All processes</button></header>
          <div id="busiest">${Z(5)}</div>
        </section>
      </div>
      <div class="column">
        <section class="card">
          <header class="card-head"><h2>Coming up</h2><button type="button" class="link" data-go="tasks/upcoming">All tasks</button></header>
          <div id="upcoming">${Z(5)}</div>
        </section>
        <section class="card">
          <header class="card-head"><h2>Storage</h2><button type="button" class="link" data-go="databases/capacity">Capacity</button></header>
          <div id="storage">${Z(3)}</div>
        </section>
      </div>
    </div>`;const e=p=>p.querySelectorAll("[data-go]").forEach(v=>v.addEventListener("click",()=>s.navigate(v.dataset.go??"")));e(s.body);let t=null,r=null,i=0;const n=Ie(s,()=>{N.refresh(),g()}),a=p=>s.body.querySelector(`#${p}`),o=()=>{if(!t)return;const p=D(t,"iris_system_info")[0]?.labels??{},v=Qe(C(t,"iris_system_state")),m=C(t,"iris_mirror_member_type"),k=m===2?"Not mirrored":m===3?"Mirror failover member":m===4?"Mirror async member":"",$=v.tone==="success"?"IRIS reports no problems":"IRIS has flagged its own health — see Needs attention",S=[`${x(p.product??"InterSystems IRIS")} ${x(p.version??"")}${p.build_number?` · build ${x(p.build_number)}`:""}`,x(p.platform??""),r?`Up ${x(r.Status.UpTime.replace(/^0d /,""))}`:"",k].filter(Boolean).join('<span class="meta-sep">·</span>');s.heading(`${x(p.id??"IRIS instance")} ${_e(v.label,v.tone,$)}`,S)},c=()=>{if(!t)return;const p=C(t,"iris_cpu_usage"),v=C(t,"iris_phys_mem_percent_used"),m=D(t,"iris_disk_percent_full"),k=m.reduce((K,le)=>le.value>K.value?le:K,m[0]??{value:NaN,labels:{}}),$=/^([a-z]:)/i.exec(k.labels.dir??"")?.[1]?.toUpperCase()??"Volume",S=C(t,"iris_directory_space",{id:k.labels.id??""}),y=C(t,"iris_process_count"),f=C(t,"iris_license_consumed"),M=f+C(t,"iris_license_available"),L=C(t,"iris_license_percent_used");F(s.body,"cpu",{value:P(p),caption:dr(h),tone:ue(p,70,90),trend:Xe(t,"iris_cpu_usage"),title:"System CPU covers everything on this machine. The IRIS figure adds up CPU used by IRIS processes over the last few seconds, measured against one core."}),F(s.body,"mem",{value:P(v),caption:"of RAM",tone:ue(v,80,92),fill:v}),F(s.body,"disk",{value:P(k.value),caption:`${$} · ${O(S)} free`,tone:ue(k.value,85,95),fill:k.value}),F(s.body,"procs",{value:B(y),caption:"active",trend:Xe(t,"iris_process_count")}),F(s.body,"lic",{value:Number.isFinite(M)?`${f} of ${M}`:"—",caption:"in use",tone:ue(L,80,95),fill:L})},l=()=>{if(!t)return;const p=[],v=Qe(C(t,"iris_system_state"));v.tone!=="success"&&v.tone!=="neutral"&&p.push({tone:v.tone==="warning"?"warning":"danger",title:`IRIS reports a ${v.label.toLowerCase()} state`,detail:i>0?`${i} alert${i===1?" is":"s are"} recorded since startup.`:"The instance has flagged its own overall health.",action:{label:"View alerts",go:"logs/alerts"}});const m=new Set;for(const f of D(t,"iris_disk_percent_full")){const M=/^([a-z]:)/i.exec(f.labels.dir??"")?.[1]?.toUpperCase()??f.labels.dir;f.value<85||m.has(M)||(m.add(M),p.push({tone:f.value>=95?"danger":"warning",title:`${x(M)} is ${P(f.value)} full`,detail:"Databases on this volume will stop growing when it fills.",action:{label:"See capacity",go:"databases/capacity"}}))}for(const f of D(t,"iris_db_max_size_mb")){if(f.value<=0)continue;const M=C(t,"iris_db_size_mb",{id:f.labels.id});M/f.value>=.9&&p.push({tone:"warning",title:`${x(f.labels.id)} is near its size limit`,detail:`${Math.round(M)} of ${Math.round(f.value)} MB used.`,action:{label:"See capacity",go:"databases/capacity"}})}const k=C(t,"iris_license_percent_used");k>=80&&p.push({tone:k>=95?"danger":"warning",title:`License ${P(k)} used`,detail:"New connections are refused when license units run out.",action:{label:"License",go:"settings/license"}});const $=C(t,"iris_trans_open_secs_max");$>=60&&p.push({tone:"warning",title:"A transaction has been open for a long time",detail:`The longest open transaction started ${Math.round($)}s ago.`,action:{label:"Processes",go:"operations/processes"}}),r?.Status.LastBackup==="Never"&&p.push({tone:"warning",title:"No backup has ever run",detail:"There is no recorded backup of this instance.",action:{label:"Schedule one",go:"tasks/new"}});const S=ne.count();i>S&&v.tone==="success"&&p.push({tone:"info",title:`${i-S} alert${i-S===1?"":"s"} raised before the portal was watching`,detail:"IRIS delivers each alert once, so these can only be read in alerts.log.",action:{label:"Details",go:"logs/alerts"}}),r&&!r.Status.SystemMonitor&&p.push({tone:"info",title:"System Monitor is not running",detail:"IRIS raises no health alerts of its own until it runs. Start it from a %SYS terminal.",action:{label:"Copy command",copy:"do ^%SYSMONMGR"}}),a("attention-count").textContent=p.length?`${p.length} item${p.length===1?"":"s"}`:"";const y=a("attention");y.innerHTML=p.length===0?'<div class="all-clear"><ev-icon name="check-circle" size="md"></ev-icon><div><strong>All clear</strong><span>Nothing on this instance needs you right now.</span></div></div>':`<ul class="attention-list">${p.map(f=>`
          <li class="attention attention--${f.tone}">
            <ev-icon name="${f.tone==="info"?"info":"alert-triangle"}" size="sm"></ev-icon>
            <div class="attention-text"><strong>${f.title}</strong><span>${f.detail}</span></div>
            ${f.action?`<button type="button" class="btn btn--sm" ${f.action.go?`data-go="${f.action.go}"`:`data-copy="${x(f.action.copy??"")}" title="${x(f.action.copy??"")}"`}>${f.action.label}</button>`:""}
          </li>`).join("")}</ul>`,e(y),y.querySelectorAll("[data-copy]").forEach(f=>f.addEventListener("click",()=>{navigator.clipboard.writeText(f.dataset.copy??"").then(()=>{f.textContent="Copied",setTimeout(()=>{f.textContent="Copy command"},1600)})}))},d=p=>{const v=a("upcoming");if(p.length===0){v.innerHTML='<div class="all-clear all-clear--neutral"><ev-icon name="calendar" size="md"></ev-icon><div><strong>Nothing scheduled</strong><span>The task manager has no upcoming runs.</span></div></div>';return}const m=new Date().toDateString(),k=[];for(const $ of p.slice(0,7)){const S=Ts($.Datetime),f=`${S.toDateString()===m?"Today":S.toLocaleDateString(void 0,{weekday:"short"})} ${S.toLocaleTimeString(void 0,{hour:"2-digit",minute:"2-digit",hourCycle:"h23"})}`,M=k[k.length-1];M&&M.when===f?M.names.push($.Name):k.push({when:f,at:S,names:[$.Name]})}v.innerHTML=k.map($=>`
      <div class="group-head"><span class="row-time">${x($.when)}</span><span class="row-meta">${x(ur($.at))}</span></div>
      <ul class="rows">${$.names.map(S=>`<li class="row row--compact"><span class="row-main">${x(S)}</span></li>`).join("")}</ul>`).join("")};let h=null;const u=p=>{h=p.total,c();const v=p.procs.map(m=>({p:m,pct:p.pct.get(m.Pid)??0})).filter(m=>m.pct>.05).sort((m,k)=>k.pct-m.pct).slice(0,6);if(!v.some(m=>m.pct>=1)){const m=v[0],k=t?Math.round(C(t,"iris_cpu_usage")):NaN;a("busiest").innerHTML=`<div class="all-clear all-clear--neutral"><ev-icon name="cpu" size="md"></ev-icon><div><strong>Idle</strong>
        <span>No IRIS process is above 1% of one core.${Number.isFinite(k)?` System CPU (${k}%) is almost all outside IRIS.`:""}${m?` Most active: <span class="mono">${x(tt(m.p.Routine||"(no routine)",30))}</span> at ${m.pct.toFixed(1)}%.`:""}</span></div></div>`;return}a("busiest").innerHTML=`<ul class="rows">${v.map(({p:m,pct:k})=>`
      <li class="row row--bar">
        <span class="row-main mono" title="${x(m.Routine)}">${x(tt(m.Routine||"(no routine)",34))}</span>
        <span class="row-sub">${m.Username?x(m.Username==="UnknownUser"?"Unauthenticated":m.Username):"System"} · PID ${x(m.Pid)}</span>
        <span class="minibar" title="Share of one CPU core"><span style="width:${Math.max(1,Math.min(100,k))}%"></span></span>
        <span class="row-meta">${k<10?k.toFixed(1):Math.round(k)}% CPU</span>
      </li>`).join("")}</ul>`},b=()=>{if(!t)return;const p=new Map;for(const m of D(t,"iris_disk_percent_full")){const k=/^([a-z]:)/i.exec(m.labels.dir??"")?.[1]?.toUpperCase()??m.labels.dir;p.has(k)||p.set(k,{full:m.value,free:C(t,"iris_directory_space",{id:m.labels.id})})}const v=D(t,"iris_db_size_mb").reduce((m,k)=>m+k.value,0);a("storage").innerHTML=`<ul class="rows">
      ${[...p].map(([m,k])=>`<li class="row row--stack">
        <div class="row-line"><span class="row-main">${x(m)}</span><span class="row-meta">${P(k.full)} used · ${O(k.free)} free</span></div>
        <div class="bar bar--${ue(k.full,85,95)}"><span style="width:${Math.min(100,k.full)}%"></span></div></li>`).join("")}
      <li class="row"><span class="row-main">Databases</span><span class="row-meta">${D(t,"iris_db_size_mb").length} · ${O(v)}</span></li>
      <li class="row"><span class="row-main">Journal files</span><span class="row-meta">${O(C(t,"iris_jrn_size"))}</span></li>
      <li class="row"><span class="row-main">Last backup</span>${r?.Status.LastBackup==="Never"?'<span class="row-meta row-meta--warning"><ev-icon name="alert-triangle" size="xs"></ev-icon>Never</span>':`<span class="row-meta">${r?x(r.Status.LastBackup):"—"}</span>`}</li>
    </ul>`},g=async()=>{const[p,v]=await Promise.allSettled([gs(),nr()]);p.status==="fulfilled"&&(r=p.value),v.status==="fulfilled"?d(v.value):(a("upcoming").innerHTML=ye(v.reason,"retry-upcoming"),a("upcoming").querySelector("#retry-upcoming")?.addEventListener("click",()=>void g())),o(),l(),b()};g();const w=setInterval(()=>void g(),3e4);s.onLeave(()=>clearInterval(w)),a("busiest").innerHTML='<div class="row-measuring">Measuring CPU use…</div>',s.onLeave(cr.subscribe((p,v)=>{if(p){u(p);return}a("busiest").innerHTML=ye(v)})),s.onLeave(N.subscribe((p,v)=>{t=p,i=C(p,"iris_system_alerts"),n(v),o(),c(),l(),b()},p=>{a("attention").innerHTML=ye(p,"retry-metrics"),a("attention").querySelector("#retry-metrics")?.addEventListener("click",()=>void N.refresh())})),s.onLeave(ne.subscribe(()=>l()))}const Is=5e3,Ds=2e4,Hs=60,vr=["AllGlobalReferences","GlobalUpdateReferences","RoutineCalls","LogicalBlockRequests","BlockReads","BlockWrites","JournalEntries"];let J=[],rt=null;const st=new Map,Me=new Set;let ve=null;async function Dt(){try{const s=await Q("/api/admin/v2/monitor/system-usage",{headers:{Accept:"application/json"}});if(!s.ok)return;const e=(await s.json()).result,t=Date.now();for(J.push({at:t,c:e});J.length>2&&t-J[1].at>=Ds;)J.shift();const r=J[0],i=(t-r.at)/1e3;if(J.length<2||i<=0)return;const n={};for(const a of vr){n[a]=Math.max(0,(e[a]-r.c[a])/i);const o=st.get(a)??[];o.push(n[a]),o.length>Hs&&o.shift(),st.set(a,o)}rt=n;for(const a of Me)a(n,new Date)}catch{}}async function Ke(){return(await(await Q("/api/admin/v2/monitor/system-usage",{headers:{Accept:"application/json"}})).json()).result}async function Ns(s){try{const e=await Ke();await Q("/api/monitor/metrics",{headers:{Accept:"text/plain"}});const t=await Ke(),r=await Ke(),i={};for(const n of vr)i[n]=Math.max(0,t[n]-e[n]-(r[n]-t[n]))/s;return i}catch{return null}}const Ht={subscribe(s){return Me.add(s),rt&&s(rt,new Date),ve||(Dt(),ve=setInterval(()=>void Dt(),Is)),()=>{Me.delete(s),Me.size===0&&ve&&(clearInterval(ve),ve=null,J=[])}},trend:s=>[...st.get(s)??[]]},pe=(s,e,t)=>s>=t?"danger":s>=e?"warning":"success",Nt=[{label:"Global references",key:"AllGlobalReferences",hint:"Reads and writes of globals"},{label:"Global updates",key:"GlobalUpdateReferences",hint:"SET and KILL operations on globals"},{label:"Logical reads",key:"LogicalBlockRequests",hint:"Database blocks requested, from cache or disk"},{label:"Physical reads",key:"BlockReads",hint:"Database blocks read from disk"},{label:"Physical writes",key:"BlockWrites",hint:"Database blocks written to disk"},{label:"Routine calls",key:"RoutineCalls",hint:"Routine calls"},{label:"SQL statements",key:"sql",hint:"SQL statements per second, averaged by IRIS"},{label:"Journal entries",key:"JournalEntries",hint:"Journal records created"}];function Bt(s,e,t,r){const i=s.querySelector(`[data-metric="${e}"]`);i.querySelector(".v").textContent=Number.isFinite(t)?B(t):"—",i.querySelector("ev-sparkline").values=r.length?r:[0,0]}function Bs(s){s.body.innerHTML=`
    <section class="stats stats--4">
      ${W("cpu","System CPU","trend")}
      ${W("mem","Memory","bar")}
      ${W("page","Page file","bar")}
      ${W("smh","Shared memory","bar")}
    </section>
    <section class="card">
      <header class="card-head"><h2>Throughput</h2><span class="card-hint">Per second · 20 s average</span></header>
      <div class="metric-grid">
        ${Nt.map(l=>`
          <div class="metric" data-metric="${l.key}" title="${x(l.hint)}">
            <span class="metric-label">${l.label}</span>
            <span class="metric-value"><span class="v">—</span><span class="unit">/s</span></span>
            <ev-sparkline type="line" width="112" height="28" min="0" max="10"></ev-sparkline>
            <span class="metric-own"></span>
          </div>`).join("")}
      </div>
    </section>
    <div class="grid-5">
      <section class="card span-3">
        <header class="card-head"><h2>Storage</h2><button type="button" class="link" data-go="databases/capacity">Database capacity</button></header>
        <div id="storage">${Z(4)}</div>
      </section>
      <section class="card span-2">
        <header class="card-head"><h2>Sessions &amp; engine</h2></header>
        <div id="engine">${Z(4)}</div>
      </section>
    </div>`,s.body.querySelectorAll("[data-go]").forEach(l=>l.addEventListener("click",()=>s.navigate(l.dataset.go??"")));const e=l=>s.body.querySelector(`#${l}`),t=Ie(s,()=>void N.refresh());let r=null,i=null;s.onLeave(cr.subscribe(l=>{r=l?l.total:null,i&&n(i)}));const n=l=>{i=l;const d=C(l,"iris_cpu_usage"),h=C(l,"iris_phys_mem_percent_used"),u=C(l,"iris_page_space_percent_used"),b=C(l,"iris_smh_total_percent_full");F(s.body,"cpu",{value:P(d),caption:dr(r),tone:pe(d,70,90),trend:Xe(l,"iris_cpu_usage"),title:"System CPU covers everything on this machine. The IRIS figure adds up CPU used by IRIS processes over the last few seconds, measured against one core."}),F(s.body,"mem",{value:P(h),caption:"of RAM",tone:pe(h,80,92),fill:h}),F(s.body,"page",{value:P(u),caption:"of allocated swap",tone:pe(u,70,90),fill:u}),F(s.body,"smh",{value:P(b),caption:"of instance heap",tone:pe(b,80,92),fill:b}),Bt(s.body,"sql",C(l,"iris_sql_queries_per_second",{id:"all"}),N.trend("iris_sql_queries_per_second",{id:"all"}));const g=new Map;for(const S of D(l,"iris_disk_percent_full")){const y=/^([a-z]:)/i.exec(S.labels.dir??"")?.[1]?.toUpperCase()??S.labels.dir;g.has(y)||g.set(y,{full:S.value,free:C(l,"iris_directory_space",{id:S.labels.id})})}const w=D(l,"iris_db_size_mb").map(S=>({id:S.labels.id,size:S.value,free:C(l,"iris_db_free_space",{id:S.labels.id}),max:C(l,"iris_db_max_size_mb",{id:S.labels.id})})).sort((S,y)=>y.size-S.size),p=`Journal files ${O(C(l,"iris_jrn_size"))}`;e("storage").innerHTML=`
      ${[...g].map(([S,y])=>`<div class="volume">
        <div class="row-line"><span class="row-main">${x(S)}</span><span class="row-meta">${P(y.full)} used · ${O(y.free)} free</span></div>
        <div class="bar bar--${pe(y.full,85,95)}"><span style="width:${Math.min(100,y.full)}%"></span></div>
        <div class="volume-sub">${w.length} databases · ${p}</div></div>`).join("")}
      <table class="mini-table">
        <thead><tr><th>Database</th><th class="r" colspan="2" title="The bar shows each database's size relative to the largest one">Size</th><th class="r">Free in file</th></tr></thead>
        <tbody>${w.map(S=>`<tr><td class="mono">${x(S.id)}</td>
          <td class="bar-col"><span class="sizebar" title="Size relative to the largest database, not how full it is"><span style="width:${S.size/Math.max(1,w[0]?.size??1)*100}%"></span></span></td>
          <td class="r">${O(S.size)}${S.max>0?` <span class="limit">/ ${O(S.max)} limit</span>`:""}</td>
          <td class="r">${O(S.free)}</td></tr>`).join("")}
        </tbody>
      </table>`;const v=D(l,"iris_csp_in_use_connections").reduce((S,y)=>S+y.value,0),m=D(l,"iris_csp_actual_connections").reduce((S,y)=>S+y.value,0),k=C(l,"iris_trans_open_count"),$=(S,y,f="")=>`<div class="kv-cell"${f?` title="${x(f)}"`:""}><dt>${S}</dt><dd>${y}</dd></div>`;e("engine").innerHTML=`<dl class="kv-grid">
      ${$("Web sessions",B(C(l,"iris_csp_sessions")))}
      ${$("Gateway connections",`${B(v)} <span class="dim">busy of</span> ${B(m)}`)}
      ${$("Gateway latency",`${(D(l,"iris_csp_gateway_latency")[0]?.value??NaN).toFixed(1)} <span class="dim">ms</span>`)}
      ${$("Open transactions",k>0?`${B(k)} <span class="dim">· longest ${Math.round(C(l,"iris_trans_open_secs_max"))}s</span>`:"None")}
      ${$("Cache efficiency",`${B(C(l,"iris_cache_efficiency"))} <span class="dim">refs / disk I/O</span>`,"Global references per physical read or write — higher is better")}
      ${$("Write daemon cycle",`${B(C(l,"iris_wd_cycle_time"))} <span class="dim">ms</span>`)}
      ${$("ECP connections",B(C(l,"iris_ecp_conn")+C(l,"iris_ecps_conn")))}
      ${$("SQL avg runtime",`${(C(l,"iris_sql_queries_avg_runtime")*1e3).toFixed(1)} <span class="dim">ms</span>`)}
    </dl>`};let a=null;const o=async()=>{a=await Ns(ar/1e3)};o();const c=setInterval(()=>void o(),12e4);s.onLeave(()=>clearInterval(c)),s.onLeave(Ht.subscribe(l=>{for(const d of Nt){if(d.key==="sql")continue;Bt(s.body,d.key,l[d.key],Ht.trend(d.key));const h=s.body.querySelector(`[data-metric="${d.key}"] .metric-own`),u=a?a[d.key]:0,b=u>=1&&u>=l[d.key]*.1;h.textContent="",b&&(h.textContent=u>=l[d.key]*.9?"Nearly all from this portal’s own monitoring":`≈${B(u)}/s from this portal’s monitoring`)}})),s.onLeave(N.subscribe((l,d)=>{t(d),n(l)},l=>{e("storage").innerHTML=ye(l,"retry-ops"),e("storage").querySelector("#retry-ops")?.addEventListener("click",()=>void N.refresh())}))}const Ps=5e3,qs={RUN:{label:"Running",tone:"success"},RUNW:{label:"Waiting",tone:"neutral"},READ:{label:"Waiting for input",tone:"neutral"},WRT:{label:"Writing output",tone:"neutral"},EVTW:{label:"Waiting for an event",tone:"neutral"},HANGW:{label:"Sleeping",tone:"neutral"},SEMW:{label:"Waiting on a semaphore",tone:"neutral"},LOCKW:{label:"Blocked on a lock",tone:"warning"},GSETW:{label:"Blocked on global buffers",tone:"warning"},GGETW:{label:"Blocked on global buffers",tone:"warning"},GCOMW:{label:"Blocked on global buffers",tone:"warning"},JRNW:{label:"Blocked on the journal",tone:"warning"}},it=s=>qs[s]??{label:s,tone:"neutral"},pr=s=>s==="HANGW"?"State code HANGW: pausing on a HANG command, which is intentional":`State code ${s}`,Pt=s=>s.Username==="",qt=s=>s==="UnknownUser"?"Unauthenticated":s;function fr(s){return Number.isFinite(s)?`${(s/1e3).toFixed(1)} s`:"—"}const Os=[{key:"Pid",label:"PID",width:"72px",sortable:!0,align:"right",renderCell:s=>E.mono(s,!0)},{key:"Routine",label:"Current routine",width:"240px",sortable:!0,renderCell:s=>E.mono(tt(String(s||"—"),32),!1,String(s))},{key:"Username",label:"User",width:"130px",sortable:!0,renderCell:s=>s?s==="UnknownUser"?E.dim("Unauthenticated"):E.text(s):E.dim("System")},{key:"State",label:"State",width:"180px",sortable:!0,renderCell:s=>{const e=it(String(s));return _e(e.label,e.tone,pr(String(s)))}},{key:"Nspace",label:"Namespace",width:"110px",sortable:!0,renderCell:s=>s?E.mono(s):E.dim("—")},{key:"Client",label:"Client",width:"130px",sortable:!0,renderCell:s=>s?E.text(s):E.dim("—")},{key:"Commands",label:"Commands",width:"96px",sortable:!0,align:"right",renderCell:s=>E.num(B(Number(s)),Number(s).toLocaleString())},{key:"Globals",label:"Global refs",width:"96px",sortable:!0,align:"right",renderCell:s=>E.num(B(Number(s)),Number(s).toLocaleString())},{key:"CpuNow",label:"CPU %",width:"72px",sortable:!0,align:"right",renderCell:s=>s==null||Number(s)<0?E.dim("…"):Number(s)<.1?E.dim("–"):E.num(Number(s).toFixed(1))},{key:"CPUTime",label:"CPU time",width:"88px",sortable:!0,align:"right",renderCell:s=>E.num(fr(Number(s)))},{key:"Elapsed",label:"Running for",width:"100px",sortable:!0,align:"right",renderCell:(s,e)=>E.num(hr(String(e.ElapsedTime)))}],Ws=["Nspace","Client","Globals"];function Fs(s,e){const[t,r,i]=s.ElapsedTime.split(":").map(Number);return{Pid:s.Pid,Routine:s.Routine,Nspace:s.Nspace,Username:s.Username,Client:s.ClientName||s.IPAddress,State:s.State,Commands:s.Commands,Globals:s.Globals,CpuNow:e,CPUTime:s.CPUTime,ElapsedTime:s.ElapsedTime,Elapsed:t*3600+r*60+i}}function Ks(s){s.fill(),s.body.innerHTML=`
    <div class="toolbar-row">
      <div class="search-box"><ev-search id="proc-search" size="sm" full-width placeholder="Filter by routine, user, namespace or PID"></ev-search></div>
      <ev-segmented-button id="proc-scope" size="sm"></ev-segmented-button>
      <span id="proc-blocked"></span>
    </div>
    <ev-detail-panel id="proc-panel" detail-width="340" class="workspace">
      <div class="grid-wrap" id="proc-grid-wrap">${Z(10)}</div>
      <aside slot="detail" class="detail" id="proc-detail"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="proc-foot"></p>`;const e=s.body.querySelector("#proc-scope");e.value="all";const t=s.body.querySelector("#proc-panel"),r=s.body.querySelector("#proc-grid-wrap");let i=null,n=[],a="",o="all",c=null,l=null,d=new Map;const h=(y,f)=>f==="all"||(f==="user"?!Pt(y):Pt(y)),u=()=>n.filter(y=>{if(!h(y,o))return!1;if(!a)return!0;const f=a.toLowerCase();return[y.Routine,y.Username,qt(y.Username),y.Nspace,String(y.Pid),y.ClientName,y.IPAddress].some(M=>M?.toLowerCase().includes(f))}),b=()=>{const y=M=>n.filter(L=>h(L,M)).length;e.options=[{value:"all",label:`All ${y("all")}`},{value:"user",label:`User ${y("user")}`},{value:"system",label:`System ${y("system")}`}];const f=n.filter(M=>it(M.State).tone==="warning").length;s.body.querySelector("#proc-blocked").innerHTML=f?_e(`${f} blocked`,"warning","Waiting on locks, global buffers or the journal"):""},g=y=>{if(t.open!==y){t.open=y;for(const f of Ws)i?.setColumnVisible(f,!y)}},w=()=>{const y=s.body.querySelector("#proc-detail"),f=n.find(V=>V.Pid===c);if(!f){g(!1);return}const M=it(f.State),L=(V,Pe)=>`<div class="kv"><dt>${V}</dt><dd>${Pe}</dd></div>`,K=(V,Pe,Sr=!1)=>Pe?`<button type="button" class="btn btn--sm btn--locked${Sr?" btn--danger":""}" disabled title="Sign in to manage processes"><ev-icon name="key-round" size="xs"></ev-icon>${V}</button>`:"",le=[K("Suspend",f.CanBeSuspended),K("Send message",f.CanReceiveBroadcast),K("Terminate…",f.CanBeTerminated,!0)].join("");y.innerHTML=`
      <header class="detail-head">
        <div class="detail-title"><span class="detail-kicker">Process ${x(f.Pid)}</span><h2 class="mono" title="${x(f.Routine)}">${x(f.Routine||"(no routine)")}</h2></div>
        <ev-icon-button icon="x" label="Close details" id="proc-close"></ev-icon-button>
      </header>
      <div class="detail-state">${_e(M.label,M.tone,pr(f.State))}<span class="dim">for ${x(hr(f.ElapsedTime))}</span></div>
      ${le?`<div class="detail-actions">${le}</div><p class="detail-note">Actions become available once you sign in.</p>`:""}
      <h3 class="detail-section">Identity</h3>
      <dl class="kv-list">
        ${L("User",f.Username?x(qt(f.Username)):'<span class="dim">System process</span>')}
        ${L("OS user",x(f.OSUserName||"—"))}
        ${L("Namespace",f.Nspace?`<span class="mono">${x(f.Nspace)}</span>`:"—")}
        ${L("Client",x(f.ClientName||"—"))}
        ${L("IP address",f.IPAddress?`<span class="mono">${x(f.IPAddress)}</span>`:"—")}
        ${L("Executable",x(f.EXEname||"—"))}
        ${L("Device",f.Device?`<span class="mono">${x(f.Device)}</span>`:"—")}
        ${L("Job · parent PID",`<span class="mono">${x(f.Job)} · ${f.ParentPid?x(f.ParentPid):"—"}</span>`)}
      </dl>
      <h3 class="detail-section">Activity</h3>
      <dl class="kv-list">
        ${L("Commands run",f.Commands.toLocaleString())}
        ${L("Global references",f.Globals.toLocaleString())}
        ${L("Private global blocks",f.PrvGblBlkCnt.toLocaleString())}
        ${L("CPU now",d.has(f.Pid)&&(d.get(f.Pid)??-1)>=0?`${(d.get(f.Pid)??0).toFixed(1)}% of a core`:"Measuring…")}
        ${L("CPU time",fr(f.CPUTime))}
      </dl>`,y.querySelectorAll(".kv dd").forEach(V=>{V.title=V.textContent?.trim()??""}),y.querySelector("#proc-close")?.addEventListener("click",()=>{c=null,i?.select([]),g(!1)}),g(!0)},p=()=>{const y=u().map(f=>Fs(f,d.get(f.Pid)??-1));i||(r.innerHTML="",i=document.createElement("ev-data-grid"),i.setAttribute("compact",""),i.setAttribute("row-select",""),i.setAttribute("row-key","Pid"),i.setAttribute("sort-column","Commands"),i.setAttribute("sort-direction","desc"),i.columns=Os,i.addEventListener("ev-data-grid-row-click",f=>{c=Number(f.detail.row.Pid),w()}),r.appendChild(i)),i.rows=y,c!==null&&i.select([String(c)]),r.querySelector(".grid-empty")?.remove(),y.length===0&&r.insertAdjacentHTML("beforeend",`<div class="grid-empty">No processes match “${x(a)}”.</div>`)};let v=NaN;const m=()=>{const y=[...d.values()].filter(M=>M>=0),f=y.reduce((M,L)=>M+L,0);s.body.querySelector("#proc-foot").innerHTML=y.length?`IRIS processes together: <b>${f.toFixed(1)}%</b> of one core<span class="meta-sep">·</span>System CPU <b>${Number.isFinite(v)?Math.round(v):"—"}%</b> across the whole machine`:"Measuring CPU use…"};s.onLeave(N.subscribe(y=>{v=C(y,"iris_cpu_usage"),m()}));const k=Ie(s,()=>void $()),$=async()=>{try{n=await ir();const y=performance.now();if(l){const f=(y-l.at)/1e3,M=l.byPid;d=new Map(n.map(L=>[L.Pid,M.has(L.Pid)?Math.max(0,(L.CPUTime-(M.get(L.Pid)??0))/1e3/f*100):-1]))}l={at:y,byPid:new Map(n.map(f=>[f.Pid,f.CPUTime]))},k(new Date),b(),p(),m(),c!==null&&w()}catch(y){i=null,r.innerHTML=ye(y,"retry-proc"),r.querySelector("#retry-proc")?.addEventListener("click",()=>void $())}};s.body.querySelector("#proc-search")?.addEventListener("ev-search-input",y=>{a=y.detail.value.trim(),p()}),e.addEventListener("ev-segmented-button-change",y=>{o=y.detail.value,p()}),$();const S=setInterval(()=>void $(),Ps);s.onLeave(()=>clearInterval(S))}const Vs=[{key:"time",label:"When",width:"130px",sortable:!0,renderCell:s=>{const e=new Date(String(s));return E.text(ur(e),e.toLocaleString())}},{key:"severity",label:"Severity",width:"100px",sortable:!0,renderCell:s=>{const e=et(String(s));return _e(e.label,e.tone)}},{key:"source",label:"Source",width:"140px",sortable:!0,renderCell:s=>s?E.mono(s):E.dim("—")},{key:"message",label:"Message",renderCell:s=>E.wrap(String(s))}];function Us(s){const e=/^(?:ISCLOG:\s*)?([\w.%-]+)\s+\[[^\]]*\]\s*(.*)$/.exec(s.message);return e?{source:e[1],message:e[2]}:{source:"",message:s.message}}function js(s){s.body.innerHTML=`
    <div class="toolbar-row">
      <ev-segmented-button id="alert-filter" size="sm"></ev-segmented-button>
      <div class="toolbar-spacer"></div>
      <span class="summary" id="alert-summary"></span>
      <button type="button" class="btn btn--sm btn--quiet" id="alert-clear" hidden>Clear list</button>
    </div>
    <div class="grid-card" id="alert-wrap"></div>`;const e=s.body.querySelector("#alert-filter");e.value="all";const t=s.body.querySelector("#alert-clear"),r=s.body.querySelector("#alert-wrap");let i="all",n=[],a=NaN,o="";const c=()=>{const d=p=>n.filter(v=>p==="all"||et(v.severity).tone===p).length;e.options=["all","danger","warning","info"].map(p=>({value:p,label:`${{all:"All",danger:"Severe",warning:"Warning",info:"Info"}[p]} ${d(p)}`,disabled:p!=="all"&&d(p)===0}));const h=n.length>0;s.body.querySelector(".toolbar-row").hidden=!h,t.hidden=!h,s.body.querySelector("#alert-summary").innerHTML=h&&Number.isFinite(a)?`<b>${a}</b> raised since IRIS started`:"";const u=n.filter(p=>i==="all"||et(p.severity).tone===i);if(u.length>0){let p=r.querySelector("ev-data-grid");p||(r.innerHTML="",p=document.createElement("ev-data-grid"),p.setAttribute("compact",""),p.setAttribute("row-key","id"),p.setAttribute("sort-column","time"),p.setAttribute("sort-direction","desc"),p.columns=Vs,r.appendChild(p)),p.rows=u.map(v=>({id:v.time+v.message,time:v.time,severity:v.severity,...Us(v)}));return}const b=Number.isFinite(a)?a-n.length:0,g=o?`<code class="path">${x(o)}alerts.log</code>`:"alerts.log in the instance’s mgr directory";r.innerHTML=b>0&&n.length===0?`<div class="empty">
          <div class="empty-main">
            <ev-icon name="info" size="md"></ev-icon>
            <div class="empty-text">
              <strong>IRIS has raised ${b} alert${b===1?"":"s"} since it started — ${b===1?"it":"they"} can’t be shown here</strong>
              <span class="lead">${b===1?"It is":"They are"} recorded in ${g}.</span>
              <span>IRIS delivers each alert once, and ${b===1?"this one was":"these were"} delivered before the portal started keeping them. New alerts appear here within 30 seconds.</span>
            </div>
          </div>
          ${o?'<button type="button" class="btn btn--sm" id="copy-path"><ev-icon name="copy" size="xs"></ev-icon>Copy path</button>':""}
        </div>`:`<div class="empty">
          <ev-icon name="check-circle" size="md"></ev-icon>
          <div class="empty-text">
            <strong>${n.length===0?"No alerts":"No alerts at this severity"}</strong>
            <span>${n.length===0?"IRIS hasn’t raised an alert since it started. New alerts appear here within 30 seconds.":"Choose another severity to see the rest."}</span>
          </div>
        </div>`;const w=r.querySelector("#copy-path");w?.addEventListener("click",()=>{navigator.clipboard.writeText(`${o}alerts.log`).then(()=>{w.innerHTML='<ev-icon name="check" size="xs"></ev-icon>Copied',setTimeout(()=>{w.innerHTML='<ev-icon name="copy" size="xs"></ev-icon>Copy path'},1600)})})};e.addEventListener("ev-segmented-button-change",d=>{i=d.detail.value,c()}),t.addEventListener("click",()=>ne.clear());const l=Ie(s,()=>{ne.refresh(),N.refresh()});s.onLeave(ne.subscribe(d=>{n=d,c()})),s.onLeave(N.subscribe((d,h)=>{l(h),a=C(d,"iris_system_alerts"),o=D(d,"iris_db_size_mb").find(u=>u.labels.id==="IRISSYS")?.labels.dir??"",c()}))}function De(s){s.innerHTML='<div class="load-note">Loading…</div>'}function He(s,e){s.innerHTML=`<div class="error-note">${e instanceof Error?e.message:String(e)}</div>`}function br(s){return s?'<span class="badge on"><span></span>Enabled</span>':'<span class="badge off"><span></span>Disabled</span>'}function z(s,e){return t=>{t.innerHTML=`<div class="stub">
      <span class="tag">Wireframe stub · endpoint ready</span>
      <h3>Screen not built yet</h3>
      <p>${e}</p>
      <span class="ep">${s}</span>
    </div>`}}async function Gs(s){De(s);try{const e=await _s();s.innerHTML=`<div class="card">
      <div class="hd"><h3>Users</h3><span class="hint">GET /api/admin/v2/security/users</span></div>
      <table class="portal-table">
        <tr><th>Name</th><th>Full name</th><th>Type</th><th>Status</th></tr>
        ${e.map(t=>`<tr><td class="mono">${t.Name}</td><td>${t.FullName}</td><td>${t.Type}</td><td>${br(t.Enabled)}</td></tr>`).join("")}
      </table>
    </div>`}catch(e){He(s,e)}}async function Js(s){De(s);try{const e=await ws();s.innerHTML=`<div class="card">
      <div class="hd"><h3>Web applications</h3><span class="hint">GET /api/admin/v2/web-apps · ${e.length} total</span></div>
      <table class="portal-table">
        <tr><th>Path</th><th>Dispatch class</th><th>Namespace</th><th>Status</th></tr>
        ${e.map(t=>`<tr><td class="mono">${t.Name}</td><td class="mono">${t.DispatchClass}</td><td class="mono">${t.Namespace}</td><td>${br(t.Enabled)}</td></tr>`).join("")}
      </table>
    </div>`}catch(e){He(s,e)}}async function Ys(s){De(s);try{const e=await nr();s.innerHTML=`<div class="card">
      <div class="hd"><h3>Upcoming tasks</h3><span class="hint">GET /api/admin/v2/task/upcoming · ${e.length} scheduled</span></div>
      <table class="portal-table">
        <tr><th>Task</th><th>Namespace</th><th>Next run</th></tr>
        ${e.map(t=>`<tr><td>${t.Name}</td><td class="mono">${t.Namespace}</td><td class="mono">${t.Datetime}</td></tr>`).join("")}
      </table>
    </div>`}catch(e){He(s,e)}}async function Zs(s){De(s);try{const e=await xs();s.innerHTML=`<div class="card">
      <div class="hd"><h3>Namespaces</h3><span class="hint">GET /api/admin/v2/namespaces</span></div>
      <table class="portal-table">
        <tr><th>Name</th></tr>
        ${e.map(t=>`<tr><td class="mono">${t.Name}</td></tr>`).join("")}
      </table>
    </div>`}catch(e){He(s,e)}}const Ae=[{key:"home",label:"Home",icon:"info",nav:[{key:"overview",label:"Overview",screen:Rs}]},{key:"operations",label:"Operations",icon:"cpu",nav:[{key:"overview",label:"Activity",description:"How hard the instance is working, now and over the last five minutes.",screen:Bs},{key:"processes",label:"Processes",description:"Every process running on the instance. Select one for its details.",screen:Ks},{key:"locks",label:"Locks",render:z("/api/admin/v2/locks","Live lock table with holder, waiters and resource.")},{key:"journals",label:"Journals",render:z("/api/admin/v2/journal/files","Journal files, switch controls and integrity checks.")},{key:"sessions",label:"Web sessions",render:z("/api/admin/v2/web-sessions","Active CSP/REST sessions with terminate action.")},{key:"jobs",label:"Background jobs",render:z("/api/admin/v2/async-results","Long-running admin operations you triggered — track, cancel, pause, resume.")},{key:"langservers",label:"Language servers",render:z("/api/admin/v2/ext-lang-servers","Python / embedded-language gateway processes — start, stop, activity.")},{key:"devices",label:"Devices",render:z("/api/admin/v2/devices","Device & device-subtype configuration (telnet/serial I/O).")},{key:"ecp",label:"ECP",render:z("/api/admin/v2/ecp/settings","Distributed-cache connections between application and data servers.")}]},{key:"tasks",label:"Tasks",icon:"calendar",nav:[{key:"upcoming",label:"Upcoming",render:Ys},{key:"history",label:"History",render:z("/api/admin/v2/task/history","Run history with status, duration and output per task.")},{key:"schedule",label:"Schedule",render:z("/api/admin/v2/task/manager","Recurring schedule editor.")},{key:"new",label:"New task",render:z("/api/admin/v2/task/manager/run","Guided task creation.")}]},{key:"logs",label:"Logs",icon:"file-text",nav:[{key:"alerts",label:"Alerts & errors",description:"Alerts IRIS has raised about its own health.",screen:js},{key:"audit",label:"Audit log",render:z("/api/admin/v2/security/audit/records","Searchable audit-record browser with export; event configuration alongside.")}]},{key:"web",label:"Web & APIs",icon:"globe",nav:[{key:"apps",label:"Web applications",render:Js},{key:"explorer",label:"API explorer",render:z("/api/mgmnt/v1/%25SYS/spec/{app}","Embedded Swagger-style browser fed by the live discovery endpoint.")},{key:"docdb",label:"DocDB applications",render:z("/api/admin/v2/doc-dbs","Native document-database applications.")},{key:"privroutine",label:"Privileged routine apps",render:z("/api/admin/v2/security/privileged-routines","Routine-based applications granted privileged execution.")}]},{key:"security",label:"Security",icon:"key-round",nav:[{key:"users",label:"Users",render:Gs},{key:"roles",label:"Roles",render:z("/api/admin/v2/security/roles","Role definitions and their assigned resources.")},{key:"resources",label:"Resources",render:z("/api/admin/v2/security/resources","Security resources and their public/protected state.")},{key:"sqlpriv",label:"SQL privileges",render:z("/api/admin/v2/security/sql-privileges","Table, column and admin-level SQL grants.")},{key:"wallet",label:"Secrets wallet",render:z("/api/admin/v2/wallet/secrets","Credential vault — masked by default, explicit reveal.")},{key:"certs",label:"Certificates & TLS",render:z("/api/admin/v2/security/x509-credentials","X.509 credentials and SSL/TLS configurations.")},{key:"oauth",label:"OAuth 2.0",render:z("/api/admin/v2/security/oauth2","Client, server and resource-server configuration.")},{key:"services",label:"Services",render:z("/api/admin/v2/security/services","%Service_* bindings — enable/disable, allowed IPs.")},{key:"fsaccess",label:"Filesystem access",render:z("/api/admin/v2/fs-access-purposes","Which OS paths IRIS processes may touch.")},{key:"encryption",label:"Encryption",render:z("/api/admin/v2/security/encryption","Key files, database encryption, data-element encryption.")},{key:"superservers",label:"Superservers",render:z("/api/admin/v2/security/superservers","Superserver port bindings and SSL.")},{key:"mft",label:"Managed file transfer",render:z("/api/admin/v2/security/mft/connections","Managed file-transfer connections.")}]},{key:"databases",label:"Databases",icon:"archive",nav:[{key:"namespaces",label:"Namespaces",render:Zs},{key:"databases",label:"Databases",render:z("/api/admin/v2/databases","Config.Databases entries.")},{key:"local",label:"Local databases",render:z("/api/admin/v2/database-dirs","Mount, dismount, compact, defragment, truncate, integrity check, expand.")},{key:"capacity",label:"Capacity",render:z("/api/monitor/metrics","Per-database size / free-space / % full — from %Api.Monitor, not %Api.Admin.")}]},{key:"settings",label:"Settings",icon:"settings",nav:[{key:"license",label:"License",render:z("/api/admin/v2/license/key","License key and license servers.")},{key:"wqm",label:"Work queue categories",render:z("/api/admin/v2/wqm-categories","Parallel work-queue tuning.")}]}],Xs={xs:"var(--ev-field-width-xs)",sm:"var(--ev-field-width-sm)",md:"var(--ev-field-width-md)",lg:"var(--ev-field-width-lg)",full:"100%"};let Qs=0;class ei extends A{static props={label:{type:"string",reflect:!0,default:""},hint:{type:"string",reflect:!0,default:""},error:{type:"string",reflect:!0,default:""},errorLive:{type:"string",reflect:!0,default:"assertive"},required:{type:"boolean",reflect:!0,default:!1},layout:{type:"string",reflect:!0,default:"vertical"},width:{type:"string",reflect:!0,default:""},reserve:{type:"boolean",reflect:!0,default:!1}};_cid=`ev-form-field-${++Qs}`;static styles=R`
    :host {
      display: block;
      font-family: var(--ev-font-family);
    }

    /* Host display/layout styling must not override normal HTML hiding. */
    :host([hidden]:not([hidden="until-found"])) {
      display: none !important;
    }

    /* Content-aware width: --_w is set inline from the width prop. */
    :host([width]) {
      max-width: var(--_ff-width, 100%);
    }

    .field {
      display: flex;
      /* Direction is inheritable from a parent ev-form-layout (label-position),
         with the local layout="horizontal" attribute as an explicit override. */
      flex-direction: var(--ev-form-field-direction, column);
      gap: var(--ev-form-field-gap, var(--ev-form-label-gap));
    }

    :host([layout="horizontal"]) .field {
      flex-direction: row;
    }

    /* Explicit editor/message tracks avoid unlike native/flex/grid baselines
       moving otherwise equal-height controls to different row positions. */
    .field[data-row] {
      display: grid;
      grid-template-columns: var(--ev-form-field-label-width, var(--ev-form-label-col-width)) minmax(0, 1fr);
      align-items: start;
      column-gap: var(--ev-form-label-col-gap);
      row-gap: var(--ev-space-1);
    }

    .field[data-row] .input-area { display: contents; }
    .field[data-row] slot {
      display: flex;
      flex-direction: column;
      grid-column: 2;
      grid-row: 1;
      min-width: 0;
    }
    .field[data-row] .message { grid-column: 2; grid-row: 2; }
    .field[data-row]:not([data-label]) { grid-template-columns: minmax(0, 1fr); }
    .field[data-row]:not([data-label]) slot,
    .field[data-row]:not([data-label]) .message { grid-column: 1; }
    .field[data-row][data-multiline] .label {
      align-self: var(--ev-form-field-label-block-align, start);
    }

    .label {
      font-size: var(--ev-font-size-sm);
      font-weight: var(--ev-form-field-label-weight, var(--ev-font-weight-medium));
      color: var(--ev-form-field-label-color, var(--ev-color-text-primary));
      line-height: var(--ev-line-height-normal);
    }

    .field[data-row] .label {
      /* Shared label column — set by ev-form-layout for perfect alignment. */
      width: var(--ev-form-field-label-width, var(--ev-form-label-col-width));
      flex-shrink: 0;
      text-align: var(--ev-form-field-label-align, var(--ev-form-label-align, start));
      grid-column: 1;
      grid-row: 1;
      align-self: var(--ev-form-field-label-block-align, center);
    }

    .required {
      color: var(--ev-color-danger);
      margin-inline-start: var(--ev-space-0-5);
    }

    .input-area {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: var(--ev-space-1);
    }

    /* One message row carrying hint OR error. Reserve the configured minimum;
       messages that exceed it must remain readable and can grow the row. */
    .message {
      font-size: var(--ev-font-size-xs);
      line-height: var(--ev-line-height-normal);
    }

    :host([reserve]) .message,
    .message[data-reserve] {
      min-height: calc(var(--ev-field-message-height) * var(--ev-form-field-reserve-lines, 1));
    }

    .message--hint {
      color: var(--ev-color-text-tertiary);
    }

    .message--error {
      color: var(--ev-color-danger);
    }
  `;refreshLayout(){this.update()}onRender(){this.width?this.style.setProperty("--_ff-width",Xs[this.width]??this.width):this.style.removeProperty("--_ff-width"),this._wireControl()}bindEvents(){const e=this.shadow.querySelector("slot");e&&this.listen(e,"slotchange",()=>this._wireControl()),this.listen(this.shadow,"click",t=>{t.target.closest?.(".label")&&this._primaryControl()?.focus()})}_primaryControl(){return this.firstElementChild}_wireControl(){const e=this._primaryControl();if(this.shadow.querySelector(".field")?.toggleAttribute("data-multiline",!!e&&["textarea","ev-textarea","ev-rich-text","ev-markdown-editor","ev-code-editor"].includes(e.localName)),!e)return;const t=`${this._cid}-label`,r=`${this._cid}-msg`,i=e.getAttribute("aria-labelledby")===t,n=e.getAttribute("data-evff-label"),a=n!==null&&e.getAttribute("aria-label")===n,o=e.hasAttribute("aria-label")&&!a||e.hasAttribute("label")||e.hasAttribute("aria-labelledby")&&!i;this.label&&!o?(e.setAttribute("aria-labelledby",t),e.setAttribute("aria-label",this.label),e.setAttribute("data-evff-label",this.label)):(i&&e.removeAttribute("aria-labelledby"),a&&e.removeAttribute("aria-label"),e.removeAttribute("data-evff-label")),e.getAttribute("aria-describedby")===r&&e.removeAttribute("aria-describedby");const c=e.getAttribute("data-evff-description");if(!e.hasAttribute("aria-description")||c!==null&&e.getAttribute("aria-description")===c){const d=this.error||this.hint;d?(e.setAttribute("aria-description",d),e.setAttribute("data-evff-description",d)):(e.removeAttribute("aria-description"),e.removeAttribute("data-evff-description"))}this.error?e.setAttribute("aria-invalid","true"):e.getAttribute("aria-invalid")==="true"&&e.removeAttribute("aria-invalid")}_isRowMode(){return this.layout==="horizontal"?!0:getComputedStyle(this).getPropertyValue("--ev-form-field-direction").trim()==="row"}_isReserved(){return this.reserve?!0:getComputedStyle(this).getPropertyValue("--ev-form-field-reserve").trim()==="1"}get renderMode(){return"stable"}render(){return _`<div class="field"><div class="input-area"><slot></slot></div></div>`}syncDom(){const e=this.shadow.querySelector(".field"),t=this.shadow.querySelector(".input-area");e.toggleAttribute("data-row",this._isRowMode()),e.toggleAttribute("data-label",!!this.label);let r=e.querySelector(".label");if(this.label){if(r||(r=document.createElement("label"),r.className="label",r.id=this._cid+"-label",e.prepend(r)),r.textContent=this.label,this.required){const o=document.createElement("span");o.className="required",o.textContent="*",r.append(o)}}else r?.remove();const i=this._isReserved(),n=this.error||this.hint;let a=t.querySelector(".message");n||i?(a||(a=document.createElement("span"),a.id=this._cid+"-msg",t.append(a)),a.className=this.error?"message message--error error":this.hint?"message message--hint hint":"message",a.toggleAttribute("data-reserve",i),this.error&&this.errorLive!=="off"?a.setAttribute("role",this.errorLive==="polite"?"status":"alert"):a.removeAttribute("role"),a.textContent!==n&&(a.textContent=n)):a?.remove()}}I("ev-form-field",ei);function ae(s){return s==="0"||s==="a"||s==="*"}function ti(s,e){return s==="0"?e>="0"&&e<="9":s==="a"?/[a-zA-Z]/.test(e):s==="*"?/[0-9a-zA-Z]/.test(e):!1}function ri(s){let e=0;for(const t of s)ae(t)&&e++;return e}function fe(s,e,t=0){const r=[];for(const a of e)ae(a)&&r.push(a);let i="",n=0;for(let a=0;a<s.length&&!(i.length>=r.length);a++)ti(r[i.length],s[a])&&(i+=s[a],a<t&&(n=i.length));return{raw:i,caretRaw:n}}function Ve(s,e){let t="",r=0;for(const i of e){if(r>=s.length)break;t+=ae(i)?s[r++]:i}return t}function Ot(s,e){let t=0;const r=Math.min(e,s.length);for(let i=0;i<r;i++)ae(s[i])&&t++;return t}function Wt(s,e,t){let r=0;if(e>0){let i=0;for(let n=0;n<s.length;n++)if(ae(s[n])&&(i++,i===e)){r=n+1;break}}for(;r<t&&r<s.length&&!ae(s[r]);)r++;return Math.min(r,t)}class si extends Gt{static props={type:{type:"string",reflect:!0,default:"text"},value:{type:"string",reflect:!0,default:""},name:{type:"string",reflect:!0,default:""},placeholder:{type:"string",reflect:!0,default:""},size:{type:"string",reflect:!0,default:"md"},state:{type:"string",reflect:!0,default:""},disabled:{type:"boolean",reflect:!0,default:!1},readonly:{type:"boolean",reflect:!0,default:!1},required:{type:"boolean",reflect:!0,default:!1},clearable:{type:"boolean",reflect:!0,default:!1},mask:{type:"string",reflect:!0,default:""},maskRaw:{type:"boolean",reflect:!0,default:!0},fullWidth:{type:"boolean",reflect:!0,default:!1},minlength:{type:"number",reflect:!0,default:-1},maxlength:{type:"number",reflect:!0,default:-1},pattern:{type:"string",reflect:!0,default:""},min:{type:"string",reflect:!0,default:""},max:{type:"string",reflect:!0,default:""},step:{type:"string",reflect:!0,default:""},autocomplete:{type:"string",reflect:!0,default:""}};_ariaObserver=null;onConnect(){this._ariaObserver=new MutationObserver(()=>this.update()),this._ariaObserver.observe(this,{attributes:!0,attributeFilter:["aria-label","aria-labelledby","aria-describedby","aria-description","aria-invalid"]})}onDisconnect(){this._ariaObserver?.disconnect(),this._ariaObserver=null}static styles=R`
    :host {
      display: inline-flex;
      font-family: var(--ev-font-family);
    }

    ${er}
    ${ht}
    ${tr}

    .wrapper {
      width: 100%;
    }

    /* Affix spacing appears ONLY when an affix is actually present, so a bare
       input's text sits flush at the --ev-control-padding-x edge — the same
       text inset as ev-select/ev-number-input, so values line up down a form
       column. (A wrapper gap here would push the input by one gap even with an
       empty prefix span, which is what broke column alignment.) */
    ::slotted([slot="prefix"]) { margin-inline-end: var(--ev-input-gap, var(--ev-space-2)); }
    ::slotted([slot="suffix"]) { margin-inline-start: var(--ev-input-gap, var(--ev-space-2)); }
    .clear:not(.clear--hidden) { margin-inline-start: var(--ev-input-gap, var(--ev-space-2)); }

    /* Invalid visual is driven by either the explicit state="error" prop or the
       standard aria-invalid attribute (which ev-form-field sets from its error),
       so a field's error styles its control without extra wiring. */
    :host([state="error"]) .wrapper,
    :host([aria-invalid="true"]) .wrapper {
      border-color: var(--ev-color-danger);
    }
    :host([state="error"]) .wrapper:focus-within,
    :host([aria-invalid="true"]) .wrapper:focus-within {
      box-shadow: var(--ev-shadow-focus-danger);
    }
    :host([state="success"]) .wrapper {
      border-color: var(--ev-color-success);
    }

    input {
      flex: 1;
      border: none;
      outline: none;
      background: transparent;
      color: var(--ev-input-color, var(--ev-color-text-primary));
      font: inherit;
      min-width: 0;
      padding: 0; /* text sits exactly at the shared --ev-control-padding-x inset */
      margin: 0;
    }

    input::placeholder {
      color: var(--ev-color-text-tertiary);
    }

    .prefix,
    .suffix {
      display: flex;
      align-items: center;
      color: var(--ev-color-text-tertiary);
    }

    .clear {
      display: flex;
      align-items: center;
      justify-content: center;
      width: var(--ev-control-icon-size);
      height: var(--ev-control-icon-size);
      border: none;
      background: var(--ev-input-clear-bg, var(--ev-color-secondary-subtle));
      border-radius: var(--ev-radius-full);
      cursor: pointer;
      color: var(--ev-color-text-tertiary);
      font-size: var(--ev-font-size-2xs);
      line-height: 1;
      padding: 0;
      transition: background var(--ev-transition-fast);
    }

    .clear:hover {
      background: var(--ev-color-border-strong);
      color: var(--ev-color-text-primary);
    }

    .clear--hidden {
      display: none;
    }
  `;get renderMode(){return"stable"}get validationAnchor(){return this.ref("input")??void 0}maskRawValue(){return fe(this.value,this.mask).raw}maskDisplayValue(){return Ve(this.maskRawValue(),this.mask)}get formValue(){if(!this.mask)return super.formValue;const e=this.maskRaw?this.maskRawValue():this.maskDisplayValue();return e===""?null:e}computeValidity(){const e=this.ref("input");if(!e)return super.computeValidity();if(!e.willValidate)return{flags:{},message:""};const t={};for(const i of["badInput","customError","patternMismatch","rangeOverflow","rangeUnderflow","stepMismatch","tooLong","tooShort","typeMismatch","valueMissing"])e.validity[i]&&(t[i]=!0);if(!e.validity.valid)return{flags:t,message:e.validationMessage};if(!this.mask)return{flags:{},message:""};const r=this.maskRawValue().length;return r>0&&r<ri(this.mask)?{flags:{patternMismatch:!0},message:"Please match the requested format."}:{flags:{},message:""}}applyFormResetValue(){super.applyFormResetValue(),this.syncDom()}commitMaskValue(e,t,r){const i=Ve(t,this.mask);e.value=i;const n=Wt(this.mask,r,i.length);e.setSelectionRange(n,n);const a=this.maskRaw?t:i;a!==this.value&&(this.value=a,this.syncFormState(),this.emit("ev-input-input",{value:a}))}handleMaskBeforeInput(e,t){const r=e.inputType,i=r.startsWith("insert"),n=r.startsWith("delete");if(!i&&!n||r==="insertCompositionText")return;e.preventDefault();const a=fe(t.value,this.mask).raw,o=t.selectionStart??t.value.length,c=t.selectionEnd??o;let l=Math.min(Ot(this.mask,o),a.length),d=Math.min(Ot(this.mask,c),a.length);if(d<l&&(d=l),i){const u=e.data??e.dataTransfer?.getData("text/plain")??"",b=a.slice(0,l),g=b+u+a.slice(d),{raw:w,caretRaw:p}=fe(g,this.mask,b.length+u.length);this.commitMaskValue(t,w,p);return}if(l===d)if(r.endsWith("Backward")){if(l===0)return;l--}else if(r.endsWith("Forward")){if(d>=a.length)return;d++}else return;const h=fe(a.slice(0,l)+a.slice(d),this.mask).raw;this.commitMaskValue(t,h,Math.min(l,h.length))}render(){return _`
      <div class="wrapper" data-ref="wrapper">
        <span class="prefix"><slot name="prefix"></slot></span>
        <input data-ref="input" type="text" />
        <button class="clear clear--hidden" data-ref="clear" type="button" aria-label="Clear">&times;</button>
        <span class="suffix"><slot name="suffix"></slot></span>
      </div>
    `}bindEvents(){const e=this.ref("input"),t=this.ref("clear");e&&(this.listen(e,"focus",()=>{this.emit("ev-input-focus")}),this.listen(e,"blur",()=>{this.emit("ev-input-blur")}),this.listen(e,"beforeinput",r=>{this.mask&&this.handleMaskBeforeInput(r,e)}),this.listen(e,"input",()=>{if(this.mask){const r=fe(e.value,this.mask).raw,i=Ve(r,this.mask);if(e.value!==i){e.value=i;const a=Wt(this.mask,r.length,i.length);e.setSelectionRange(a,a)}const n=this.maskRaw?r:i;n!==this.value&&(this.value=n,this.syncFormState(),this.emit("ev-input-input",{value:n}));return}this.value=e.value,this.syncFormState(),this.emit("ev-input-input",{value:e.value})}),this.listen(e,"change",()=>{this.emit("ev-input-change",{value:this.mask?this.value:e.value})}),t&&this.listen(t,"click",()=>{this.value="",e.value="",this.syncFormState(),e.focus(),this.emit("ev-input-input",{value:""}),this.emit("ev-input-change",{value:""})}))}syncDom(){const e=this.ref("input"),t=this.ref("clear");if(!e)return;e.type!==this.type&&(e.type=this.type);const r=this.mask?this.maskDisplayValue():this.value;e.value!==r&&(e.value=r),e.placeholder=this.placeholder,e.disabled=this.disabled,e.readOnly=this.readonly,e.required=this.required,e.setAttribute("aria-label",this.getAttribute("aria-label")?.trim()||this.placeholder||this.name||"Text input");const i=this.getAttribute("aria-description");i?e.setAttribute("aria-description",i):e.removeAttribute("aria-description"),this.state==="error"||this.getAttribute("aria-invalid")==="true"?e.setAttribute("aria-invalid","true"):e.removeAttribute("aria-invalid");const n=(o,c)=>{c?e.setAttribute(o,c):e.removeAttribute(o)};n("minlength",this.minlength>=0?String(this.minlength):""),n("maxlength",this.maxlength>=0?String(this.maxlength):""),n("pattern",this.pattern),n("min",this.min),n("max",this.max),n("step",this.step),n("autocomplete",this.autocomplete);const a=this.clearable&&!!this.value&&!this.disabled&&!this.readonly;t?.classList.toggle("clear--hidden",!a)}focus(e){this.ref("input")?.focus(e)}blur(){this.ref("input")?.blur()}}I("ev-input",si);class ii extends A{static formAssociated=!0;_internals=this.attachInternals();static props={variant:{type:"string",reflect:!0,default:"neutral"},size:{type:"string",reflect:!0,default:"md"},type:{type:"string",reflect:!0,default:"button"},disabled:{type:"boolean",reflect:!0,default:!1},loading:{type:"boolean",reflect:!0,default:!1},full:{type:"boolean",reflect:!0,default:!1}};static styles=R`
    :host {
      display: inline-flex;
      --ev-button-height: var(--ev-control-height, var(--ev-size-md));
      --ev-button-padding-inline: var(--ev-control-padding-x, var(--ev-space-3, 0.75rem));
      --ev-button-font-size: var(--ev-control-font-size, var(--ev-font-size-sm));
      --ev-button-gap: calc(var(--ev-space-1, 0.25rem) + 1px);
      --_button-radius-resolved: var(--ev-button-radius, 2px);
      --_button-softness-resolved: var(--ev-button-softness, 0%);
      --_button-soften-target-resolved: var(--_button-soften-target, #ffffff);
      --ev-button-spinner-size: 1em;
      --ev-button-icon-size-xs: calc(var(--ev-control-icon-size, 16px) - 3px);
      --ev-button-icon-size-sm: calc(var(--ev-control-icon-size, 16px) - 1px);
      --ev-button-icon-size-md: calc(var(--ev-control-icon-size, 16px) + 1px);
      --ev-button-icon-size-lg: calc(var(--ev-control-icon-size, 16px) + 3px);
      --ev-button-icon-size-xl: calc(var(--ev-control-icon-size, 16px) + 5px);
      --ev-button-icon-stroke-width: 2.4;
    }

    :host([full]) {
      display: flex;
      width: 100%;
    }

    ${ht}

    :host([size="xl"]) {
      --ev-control-height: var(--ev-size-xl, 2.5rem);
      --ev-control-padding-x: var(--ev-space-5, 1.25rem);
      --ev-control-padding-y: var(--ev-space-3, 0.75rem);
      --ev-control-font-size: var(--ev-font-size-xl, 1.125rem);
      --ev-control-icon-size: 20px;
    }

    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      appearance: none;
      border: 1px solid transparent;
      border-radius: var(--_button-radius-resolved);
      font-family: var(--ev-font-family);
      font-weight: var(--ev-font-weight-medium);
      cursor: pointer;
      transition:
        background var(--ev-transition-fast),
        color var(--ev-transition-fast),
        border-color var(--ev-transition-fast),
        box-shadow var(--ev-transition-fast);
      white-space: nowrap;
      line-height: 1.2;
      position: relative;
      width: auto;
      max-width: 100%;
      min-height: var(--ev-button-height);
      padding-inline: var(--ev-button-padding-inline);
      font-size: var(--ev-button-font-size);
      text-align: center;
      background: var(--_button-bg, var(--ev-color-surface-base, #ffffff));
      border-color: var(--_button-border, transparent);
      color: var(--_button-color, var(--ev-color-text-primary, #0f172a));
    }

    :host([full]) .button {
      width: 100%;
    }

    .button:hover:not(:disabled) {
      background: var(--_button-bg-hover, var(--_button-bg, var(--ev-color-surface-base)));
      border-color: var(--_button-border-hover, var(--_button-border, transparent));
      color: var(--_button-color-hover, var(--_button-color, var(--ev-color-text-primary)));
    }

    .button:active:not(:disabled) {
      background: var(--_button-bg-active, var(--_button-bg-hover, var(--_button-bg, var(--ev-color-surface-base))));
      border-color: var(--_button-border-active, var(--_button-border-hover, var(--_button-border, transparent)));
      color: var(--_button-color-active, var(--_button-color-hover, var(--_button-color, var(--ev-color-text-primary))));
    }

    .button:focus-visible {
      outline: none;
      box-shadow: var(--ev-shadow-focus);
    }

    .button:disabled {
      cursor: not-allowed;
    }

    :host([loading]) .button {
      cursor: progress;
    }

    :host([disabled]) .button {
      background: var(--ev-color-bg-elevated, #f8fafc);
      border-color: var(--ev-color-border, #e2e8f0);
      color: var(--ev-color-text-disabled, #cbd5e1);
      box-shadow: none;
    }

    :host([disabled]) .button:hover,
    :host([disabled]) .button:active {
      background: var(--ev-color-bg-elevated, #f8fafc);
      border-color: var(--ev-color-border, #e2e8f0);
      color: var(--ev-color-text-disabled, #cbd5e1);
    }

    .button--neutral {
      --_button-bg: var(--ev-color-surface-base, #ffffff);
      --_button-bg-hover: var(--ev-color-bg-elevated, #f8fafc);
      --_button-bg-active: var(--ev-color-bg-sunken, #f1f5f9);
      --_button-border: var(--ev-color-border, #e2e8f0);
      --_button-border-hover: var(--ev-color-border-strong, #cbd5e1);
      --_button-border-active: var(--ev-color-border-strong, #cbd5e1);
      --_button-color: var(--ev-color-text-primary, #0f172a);
    }

    .button--tone {
      --_button-bg: color-mix(
        in srgb,
        var(--_button-bg-base, var(--ev-color-surface-base, #ffffff)) calc(100% - var(--_button-softness-resolved)),
        var(--_button-soften-target-resolved) var(--_button-softness-resolved)
      );
      --_button-bg-hover: color-mix(
        in srgb,
        var(--_button-bg-hover-base, var(--_button-bg-base, var(--ev-color-surface-base, #ffffff))) calc(100% - var(--_button-softness-resolved)),
        var(--_button-soften-target-resolved) var(--_button-softness-resolved)
      );
      --_button-bg-active: color-mix(
        in srgb,
        var(--_button-bg-active-base, var(--_button-bg-hover-base, var(--_button-bg-base, var(--ev-color-surface-base, #ffffff)))) calc(100% - var(--_button-softness-resolved)),
        var(--_button-soften-target-resolved) var(--_button-softness-resolved)
      );
      --_button-border: color-mix(
        in srgb,
        var(--_button-border-base, var(--_button-bg-base, var(--ev-color-surface-base, #ffffff))) calc(100% - var(--_button-softness-resolved)),
        var(--_button-soften-target-resolved) var(--_button-softness-resolved)
      );
      --_button-border-hover: color-mix(
        in srgb,
        var(--_button-border-hover-base, var(--_button-bg-hover-base, var(--_button-bg-base, var(--ev-color-surface-base, #ffffff)))) calc(100% - var(--_button-softness-resolved)),
        var(--_button-soften-target-resolved) var(--_button-softness-resolved)
      );
      --_button-border-active: color-mix(
        in srgb,
        var(--_button-border-active-base, var(--_button-bg-active-base, var(--_button-bg-hover-base, var(--_button-bg-base, var(--ev-color-surface-base, #ffffff))))) calc(100% - var(--_button-softness-resolved)),
        var(--_button-soften-target-resolved) var(--_button-softness-resolved)
      );
      --_button-color: var(--_button-color-base, var(--ev-color-text-on-primary, #ffffff));
    }

    .button--brand {
      --_button-bg-base: var(--ev-color-brand, var(--ev-color-primary, #2563eb));
      --_button-bg-hover-base: var(--ev-color-brand-hover, var(--ev-color-primary-hover, #1d4ed8));
      --_button-bg-active-base: var(--ev-color-brand-active, var(--ev-color-primary-active, #1e40af));
      --_button-border-base: var(--ev-color-brand, var(--ev-color-primary, #2563eb));
      --_button-border-hover-base: var(--ev-color-brand-hover, var(--ev-color-primary-hover, #1d4ed8));
      --_button-border-active-base: var(--ev-color-brand-active, var(--ev-color-primary-active, #1e40af));
      --_button-color-base: var(--ev-color-text-on-brand, var(--ev-color-text-on-primary, #ffffff));
    }

    .button--success {
      --_button-bg-base: var(--ev-color-success, #16a34a);
      --_button-bg-hover-base: var(--ev-color-success-hover, #15803d);
      --_button-bg-active-base: var(--ev-color-success-active, #15803d);
      --_button-border-base: var(--ev-color-success, #16a34a);
      --_button-border-hover-base: var(--ev-color-success-hover, #15803d);
      --_button-border-active-base: var(--ev-color-success-active, #15803d);
      --_button-color-base: var(--ev-color-text-on-success, var(--ev-color-text-on-primary, #ffffff));
    }

    .button--info {
      --_button-bg-base: var(--ev-color-info, #0e7490);
      --_button-bg-hover-base: var(--ev-color-info-hover, #155e75);
      --_button-bg-active-base: var(--ev-color-info-active, #155e75);
      --_button-border-base: var(--ev-color-info, #0e7490);
      --_button-border-hover-base: var(--ev-color-info-hover, #155e75);
      --_button-border-active-base: var(--ev-color-info-active, #155e75);
      --_button-color-base: var(--ev-color-text-on-info, var(--ev-color-text-on-primary, #ffffff));
    }

    .button--warning {
      --_button-bg-base: var(--ev-color-warning, #d97706);
      --_button-bg-hover-base: var(--ev-color-warning-hover, #b45309);
      --_button-bg-active-base: var(--ev-color-warning-active, #b45309);
      --_button-border-base: var(--ev-color-warning, #d97706);
      --_button-border-hover-base: var(--ev-color-warning-hover, #b45309);
      --_button-border-active-base: var(--ev-color-warning-active, #b45309);
      --_button-color-base: var(--ev-color-text-on-warning, var(--ev-color-text-on-primary, #ffffff));
    }

    .button--caution {
      --_button-bg-base: var(--ev-color-caution, #eab308);
      --_button-bg-hover-base: var(--ev-color-caution-hover, #ca8a04);
      --_button-bg-active-base: var(--ev-color-caution-active, #a16207);
      --_button-border-base: var(--ev-color-caution, #eab308);
      --_button-border-hover-base: var(--ev-color-caution-hover, #ca8a04);
      --_button-border-active-base: var(--ev-color-caution-active, #a16207);
      --_button-color-base: var(--ev-color-text-on-caution, var(--ev-color-text-primary, #0f172a));
    }

    .button--danger {
      --_button-bg-base: var(--ev-color-danger, #dc2626);
      --_button-bg-hover-base: var(--ev-color-danger-hover, #b91c1c);
      --_button-bg-active-base: var(--ev-color-danger-active, #b91c1c);
      --_button-border-base: var(--ev-color-danger, #dc2626);
      --_button-border-hover-base: var(--ev-color-danger-hover, #b91c1c);
      --_button-border-active-base: var(--ev-color-danger-active, #b91c1c);
      --_button-color-base: var(--ev-color-text-on-danger, var(--ev-color-text-on-primary, #ffffff));
    }

    .button--premium {
      --_button-bg-base: var(--ev-color-premium, #7c3aed);
      --_button-bg-hover-base: var(--ev-color-premium-hover, #6d28d9);
      --_button-bg-active-base: var(--ev-color-premium-active, #5b21b6);
      --_button-border-base: var(--ev-color-premium, #7c3aed);
      --_button-border-hover-base: var(--ev-color-premium-hover, #6d28d9);
      --_button-border-active-base: var(--ev-color-premium-active, #5b21b6);
      --_button-color-base: var(--ev-color-text-on-premium, var(--ev-color-text-on-primary, #ffffff));
    }

    .button--niche {
      --_button-bg-base: var(--ev-color-niche, #4d7c0f);
      --_button-bg-hover-base: var(--ev-color-niche-hover, #3f6212);
      --_button-bg-active-base: var(--ev-color-niche-active, #3f6212);
      --_button-border-base: var(--ev-color-niche, #4d7c0f);
      --_button-border-hover-base: var(--ev-color-niche-hover, #3f6212);
      --_button-border-active-base: var(--ev-color-niche-active, #3f6212);
      --_button-color-base: var(--ev-color-text-on-niche, var(--ev-color-text-on-primary, #ffffff));
    }

    .button--accent {
      --_button-bg-base: var(--ev-color-accent, #a21caf);
      --_button-bg-hover-base: var(--ev-color-accent-hover, #86198f);
      --_button-bg-active-base: var(--ev-color-accent-active, #86198f);
      --_button-border-base: var(--ev-color-accent, #a21caf);
      --_button-border-hover-base: var(--ev-color-accent-hover, #86198f);
      --_button-border-active-base: var(--ev-color-accent-active, #86198f);
      --_button-color-base: var(--ev-color-text-on-accent, var(--ev-color-text-on-primary, #ffffff));
    }

    .button--ghost {
      --_button-bg: transparent;
      --_button-bg-hover: var(--ev-state-hover-bg, #f1f5f9);
      --_button-bg-active: var(--ev-state-active-bg, #f1f5f9);
      --_button-border: transparent;
      --_button-border-hover: transparent;
      --_button-border-active: transparent;
      --_button-color: var(--ev-color-text-primary, #0f172a);
    }

    .button--text {
      --_button-bg: transparent;
      --_button-bg-hover: var(--ev-state-selected-bg, #eff6ff);
      --_button-bg-active: var(--ev-color-brand-muted, var(--ev-color-primary-muted, #dbeafe));
      --_button-border: transparent;
      --_button-border-hover: transparent;
      --_button-border-active: transparent;
      --_button-color: var(--ev-color-brand, var(--ev-color-primary, #2563eb));
      padding-inline: var(--ev-space-1);
    }

    .spinner {
      width: var(--ev-button-spinner-size);
      height: var(--ev-button-spinner-size);
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: ev-btn-spin 0.6s linear infinite;
    }

    @keyframes ev-btn-spin {
      to {
        transform: rotate(360deg);
      }
    }

    .content {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--ev-button-gap);
      min-width: 0;
      text-align: center;
    }

    .label {
      min-width: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      line-height: 1.2;
    }

    .slot {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 0;
      min-height: var(--ev-control-icon-size, 16px);
      line-height: 0;
      flex-shrink: 0;
    }

    ::slotted([slot="start"]),
    ::slotted([slot="before"]),
    ::slotted([slot="end"]),
    ::slotted([slot="after"]) {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
      line-height: 0;
    }

    ::slotted(ev-icon[slot="start"]),
    ::slotted(ev-icon[slot="before"]),
    ::slotted(ev-icon[slot="end"]),
    ::slotted(ev-icon[slot="after"]) {
      --ev-icon-size-xs: var(--ev-button-icon-size-xs);
      --ev-icon-size-sm: var(--ev-button-icon-size-sm);
      --ev-icon-size-md: var(--ev-button-icon-size-md);
      --ev-icon-size-lg: var(--ev-button-icon-size-lg);
      --ev-icon-size-xl: var(--ev-button-icon-size-xl);
      --ev-icon-stroke-width: var(--ev-button-icon-stroke-width);
    }

    :host([loading]) .content {
      /* opacity (not visibility) — a visibility:hidden label is dropped from
         the accessible name and the button becomes nameless while loading
         (axe: button-name). */
      opacity: 0;
    }

    :host([loading]) .spinner {
      position: absolute;
    }
  `;getResolvedVariant(){switch(this.variant){case"primary":case"brand":return"brand";case"secondary":case"default":case"":case"neutral":return"neutral";case"success":case"info":case"warning":case"caution":case"danger":case"premium":case"niche":case"accent":case"ghost":case"text":return this.variant;default:return"neutral"}}isToneVariant(e){return["brand","success","info","warning","caution","danger","premium","niche","accent"].includes(e)}render(){const e=this.disabled||this.loading,t=this.querySelector('[slot="start"], [slot="before"]')!==null,r=this.querySelector('[slot="end"], [slot="after"]')!==null,i=this.getResolvedVariant(),n=this.isToneVariant(i),a=["content",t?"has-start":"",r?"has-end":""].filter(Boolean).join(" "),o=this.getAttribute("aria-label")?.trim();return _`
      <button
        class="button ${n?"button--tone ":""}button--${i}"
        type="${this.type}"
        ${e?"disabled":""}
        ${o?_`aria-label="${o}"`:""}
        aria-busy="${this.loading}"
        part="base"
      >
        ${this.loading?_`<span class="spinner" part="spinner" aria-hidden="true"></span>`:""}
        <span class="${a}" part="content">
          ${t?_`<span class="slot slot--start" part="start">
                <slot name="start"></slot>
                <slot name="before"></slot>
              </span>`:""}
          <span class="label" part="label">
            <slot></slot>
          </span>
          ${r?_`<span class="slot slot--end" part="end">
                <slot name="end"></slot>
                <slot name="after"></slot>
              </span>`:""}
        </span>
      </button>
    `}bindEvents(){const e=this.query("button");e&&(this.listen(e,"click",t=>{if(this.disabled||this.loading){t.stopPropagation();return}this.emit("ev-button-click");const r=this._internals.form;r&&(this.type==="submit"?r.requestSubmit():this.type==="reset"&&r.reset())}),this.listen(e,"focus",()=>{this.emit("ev-button-focus")}),this.listen(e,"blur",()=>{this.emit("ev-button-blur")}))}focus(e){this.query("button")?.focus(e)}blur(){this.query("button")?.blur()}click(){this.query("button")?.click()}}I("ev-button",ii);async function ni(s){if(G.signedIn)return;const e=await bs();s.innerHTML=`
    <div class="signin">
      <form class="signin-card" novalidate>
        <div class="signin-brand"><span class="mark">OS</span>OSCA Portal</div>
        <h1>Sign in</h1>
        <p class="signin-sub">to the InterSystems IRIS instance at <b>${x(location.host)}</b></p>
        <ev-form-field label="Username" id="f-user">
          <ev-input id="in-user" name="user" autocomplete="username" full-width></ev-input>
        </ev-form-field>
        <ev-form-field label="Password" id="f-pass">
          <ev-input id="in-pass" name="password" type="password" autocomplete="current-password" full-width></ev-input>
        </ev-form-field>
        <details class="signin-more">
          <summary>More options</summary>
          <ev-form-field label="Escalation role" hint="Optional. Sign in with a role that grants elevated privileges, if your account has one.">
            <ev-input id="in-role" name="role" full-width></ev-input>
          </ev-form-field>
        </details>
        <ev-button id="btn-signin" type="submit" variant="brand" full>Sign in</ev-button>
        ${e?`<div class="signin-alt">
          <button type="button" class="link" id="btn-anon">Continue without signing in</button>
          <span>This instance lets the Admin API answer without a sign-in.</span>
        </div>`:""}
      </form>
    </div>`;const t=s.querySelector("form"),r=s.querySelector("#in-user"),i=s.querySelector("#in-pass"),n=s.querySelector("#in-role"),a=s.querySelector("#btn-signin"),o=s.querySelector("#f-pass"),c=s.querySelector("#f-user");return requestAnimationFrame(()=>r.focus()),new Promise(l=>{const d=async()=>{if(c.error=r.value.trim()?"":"Enter your IRIS username.",o.error=i.value?"":"Enter your password.",!(c.error||o.error)){a.loading=!0;try{await fs(r.value.trim(),i.value,n.value.trim()),l()}catch(h){o.error=h instanceof ee?h.message:"Sign-in failed. Try again.",i.state="error",i.value="",i.focus()}finally{a.loading=!1}}};t.addEventListener("submit",h=>{h.preventDefault(),d()}),a.addEventListener("ev-button-click",()=>void d()),t.addEventListener("keydown",h=>{h.key==="Enter"&&(h.preventDefault(),d())}),s.querySelector("#btn-anon")?.addEventListener("click",()=>{G.continueAnonymously(),l()})})}class ai extends A{static props={type:{type:"string",reflect:!0,default:"line"},width:{type:"number",reflect:!0,default:80},height:{type:"number",reflect:!0,default:24},color:{type:"string",reflect:!0,default:""},min:{type:"number",reflect:!0,default:Number.NaN},max:{type:"number",reflect:!0,default:Number.NaN}};_domain(e,t){let r=Math.min(...e,...t?[0]:[]),i=Math.max(...e,...t?[0]:[]);return Number.isFinite(this.min)&&(r=Math.min(r,this.min)),Number.isFinite(this.max)&&(i=Math.max(i,this.max)),[r,i]}_values=[];_measuredWidth=0;_resizeObserver=null;_measureFrame=0;get values(){return this._values}set values(e){this._values=e,this.update()}static styles=R`
    :host {
      display: inline-flex;
      align-items: center;
      vertical-align: middle;
      max-width: 100%;
      min-width: 0;
    }

    svg {
      display: block;
      max-width: 100%;
    }

    .line {
      fill: none;
      stroke: var(--ev-sparkline-color, var(--ev-color-primary));
      stroke-width: 1.5;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .area {
      fill: var(--ev-sparkline-color, var(--ev-color-primary));
      opacity: 0.15;
    }

    .bar {
      fill: var(--ev-sparkline-color, var(--ev-color-primary));
      opacity: 0.8;
    }
  `;onConnect(){this._measuredWidth=this._resolveWidth(this.width),this._resizeObserver=new ResizeObserver(e=>{const t=Math.round(e[0]?.contentRect.width??0);t>0&&t!==this._measuredWidth&&(this._measuredWidth=t,this.update())}),this._resizeObserver.observe(this),this._queueMeasureSync()}onDisconnect(){this._resizeObserver&&(this._resizeObserver.disconnect(),this._resizeObserver=null),this._measureFrame&&(jr(this._measureFrame),this._measureFrame=0)}onRender(){this._queueMeasureSync()}render(){const e=this._resolveWidth(this.width),t=this.height;if(this._values.length===0)return _`<svg width="${e}" height="${t}" aria-hidden="true"></svg>`;const r=this.color?`--ev-sparkline-color: ${this.color}`:"";return this.type==="bar"?this._renderBar(r,e,t):this._renderLine(r,e,t)}_renderLine(e,t,r){const i=this._values,[n,a]=this._domain(i,!1),o=a-n||1,c=2,l=r-c*2,h=`M${i.map((b,g)=>{const w=i.length===1?t/2:g/(i.length-1)*t,p=c+l-(b-n)/o*l;return`${w.toFixed(1)},${p.toFixed(1)}`}).join("L")}`,u=`${h}L${t},${r}L0,${r}Z`;return _`
      <svg width="${t}" height="${r}" style="${e}" role="img" aria-label="${this._ariaLabel()}">
        <path class="area" d="${u}" />
        <path class="line" d="${h}" />
      </svg>
    `}_ariaLabel(){const e=this._values.length,t=this._values[e-1];return`Trend, ${e} ${e===1?"point":"points"}, latest ${t}`}_renderBar(e,t,r){const i=this._values,[n,a]=this._domain(i,!0),o=a-n||1,c=1,l=Math.max(1,r-c*2),d=Math.max(1,t/i.length-1),h=1,u=w=>c+(a-w)/o*l,b=u(0),g=i.map((w,p)=>{const v=u(w),m=Math.min(v,b),k=Math.abs(v-b),$=p*(d+h);return _`<rect class="bar" x="${$.toFixed(1)}" y="${m.toFixed(1)}" width="${d.toFixed(1)}" height="${k.toFixed(1)}" rx="0.5" />`});return _`<svg width="${t}" height="${r}" style="${e}" role="img" aria-label="${this._ariaLabel()}">${g}</svg>`}_resolveWidth(e){const t=Math.round(this.getBoundingClientRect().width);return t>0?t:this._measuredWidth>0?this._measuredWidth:e}_queueMeasureSync(){this._measureFrame||(this._measureFrame=X(()=>{this._measureFrame=0;const e=this._resolveWidth(this.width);e>0&&e!==this._measuredWidth&&(this._measuredWidth=e,this.update())}))}}I("ev-sparkline",ai);class oi extends A{static props={label:{type:"string",reflect:!0,default:""},value:{type:"string",reflect:!0,default:""},delta:{type:"string",reflect:!0,default:""},context:{type:"string",reflect:!0,default:""},tone:{type:"string",reflect:!0,default:"info"},trendColor:{type:"string",reflect:!0,default:""},trendType:{type:"string",reflect:!0,default:"line"}};_trendValues=[];get trendValues(){return this._trendValues}set trendValues(e){this._trendValues=Array.isArray(e)?e:[],this.update()}static styles=R`
    :host {
      display: block;
      font-family: var(--ev-font-family);
      color: var(--ev-stat-color, var(--ev-color-text-primary));
    }

    .card {
      display: grid;
      gap: var(--ev-stat-gap, var(--ev-space-3));
      min-width: 0;
      padding: var(--ev-stat-padding, var(--ev-space-4));
      border-radius: var(--ev-stat-radius, var(--ev-radius-lg));
      border: 1px solid var(--ev-stat-border, var(--ev-color-border));
      background: var(--ev-stat-bg, var(--ev-color-surface-base));
      box-shadow: var(--ev-stat-shadow, none);
    }

    .top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--ev-space-3);
    }

    /* #87: rich-content slots + a slotted value hides the string fallback. */
    .label-row {
      display: flex;
      align-items: center;
      gap: var(--ev-space-1-5);
    }
    .top-end {
      display: flex;
      align-items: center;
      gap: var(--ev-space-2);
      flex-shrink: 0;
    }
    :host([data-slotted-value]) [data-ref="value"] { display: none; }

    .copy {
      min-width: 0;
      display: grid;
      gap: var(--ev-space-1);
    }

    .label {
      margin: 0;
      font-size: var(--ev-stat-label-size, var(--ev-font-size-xs));
      letter-spacing: var(--ev-stat-label-spacing, 0.16em);
      text-transform: uppercase;
      color: var(--ev-stat-label-color, var(--ev-color-text-tertiary));
    }

    .value--empty {
      color: var(--ev-color-text-tertiary);
    }

    .value {
      margin: 0;
      font-size: var(--ev-stat-value-size, clamp(1.75rem, 2vw, 2.5rem));
      line-height: var(--ev-stat-value-line-height, 1);
      letter-spacing: var(--ev-stat-value-spacing, -0.03em);
      font-weight: var(--ev-font-weight-bold);
      color: inherit;
    }

    .delta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      align-self: flex-start;
      padding: 6px 10px;
      border-radius: var(--ev-radius-full);
      background: var(--ev-stat-pill-bg, var(--ev-color-secondary-subtle));
      color: var(--ev-stat-accent, var(--ev-color-text-secondary));
      font-size: var(--ev-font-size-xs);
      font-weight: var(--ev-font-weight-semibold);
      white-space: nowrap;
    }

    .delta--hidden,
    .context--hidden,
    .trend--hidden {
      display: none;
    }

    .context {
      color: var(--ev-stat-context-color, var(--ev-color-text-secondary));
      line-height: var(--ev-line-height-relaxed);
    }

    .trend {
      display: block;
      width: 100%;
      min-width: 0;
    }
  `;get renderMode(){return"stable"}render(){return _`
      <article class="card" part="card" data-ref="card">
        <div class="top">
          <div class="copy">
            <div class="label-row">
              <slot name="icon"></slot>
              <h3 class="label" part="label" data-ref="label"></h3>
            </div>
            <p class="value" part="value">
              <strong data-ref="value"></strong><slot name="value" data-ref="value-slot"></slot>
            </p>
          </div>
          <div class="top-end">
            <span class="delta delta--hidden" part="delta" data-ref="delta"></span>
            <slot name="actions"></slot>
          </div>
        </div>
        <p class="context context--hidden" part="context" data-ref="context"></p>
        <ev-sparkline class="trend trend--hidden" part="trend" data-ref="trend" height="34"></ev-sparkline>
      </article>
    `}syncDom(){const e=Ee(this.tone,"info"),t=Te(e,"info"),r=this.ref("label"),i=this.ref("value"),n=this.ref("delta"),a=this.ref("context"),o=this.ref("card"),c=this.ref("trend");o&&o.setAttribute("style",ie({"--ev-stat-accent":t.accent,"--ev-stat-pill-bg":t.subtleBg})),r&&(r.textContent=this.label);const d=!!this.query('slot[name="value"]')?.assignedNodes({flatten:!0}).some(h=>h.nodeType===Node.ELEMENT_NODE||(h.textContent??"").trim()!=="");if(d?this.setAttribute("data-slotted-value",""):this.removeAttribute("data-slotted-value"),i){const h=this.value!=="";i.textContent=h?this.value:d?"":"—",i.classList.toggle("value--empty",!h&&!d),h||d?i.removeAttribute("aria-label"):i.setAttribute("aria-label","No data")}if(n&&(n.textContent=this.delta,n.classList.toggle("delta--hidden",!this.delta)),a&&(a.textContent=this.context,a.classList.toggle("context--hidden",!this.context)),c){const h=this._trendValues.length>0;c.classList.toggle("trend--hidden",!h),c.type=this.trendType,c.color=this.trendColor||t.accent,c.values=this._trendValues}}bindEvents(){const e=this.query('slot[name="value"]');e&&this.listen(e,"slotchange",()=>this.update())}}I("ev-stat",oi);const li=200,Ft=10,ci=35;class di extends A{static props={selectable:{type:"boolean",reflect:!0,default:!1},rowSelect:{type:"boolean",reflect:!0,default:!1},striped:{type:"boolean",reflect:!0,default:!0},compact:{type:"boolean",reflect:!0,default:!1},sortColumn:{type:"string",reflect:!0,default:""},sortDirection:{type:"string",reflect:!0,default:"asc"},editable:{type:"boolean",reflect:!0,default:!1},expandable:{type:"boolean",reflect:!0,default:!1},groupBy:{type:"string",reflect:!0,default:""},rowKey:{type:"string",reflect:!0,default:"id"},editMode:{type:"string",reflect:!0,default:"direct"},undoable:{type:"boolean",reflect:!0,default:!1},stateId:{type:"string",reflect:!0,default:""}};_columns=[];_rows=[];_selection=new Zr("multi");_expandedRowKeys=new Set;_collapsedGroups=new Set;_expandRenderer=null;_rowIdentityKeys=new WeakMap;_nextGeneratedRowKey=0;_dataVersion=0;_viewVersion=0;_modelCache=null;_modelCacheKey="";_entryHtmlCache=new WeakMap;_headerHtml="";_rowHeight=ci;_lastScrollBucket=-1;_topSpacer=null;_bottomSpacer=null;_scratchTbody=document.createElement("tbody");_resizeObserver=null;_offLocale=null;_focusEntryKey=null;_focusColIndex=0;_pendingFocus=!1;_rovingTd=null;_frozenActive=!1;_columnOrder=[];_hiddenColumns=new Set;_columnWidths={};_dragColKey=null;_dropTh=null;_pendingEdits=new Map;_pendingEditCell=null;_processCellForClipboard=null;_store=null;_storeUnsub=null;_undoStack=null;_persistence=null;constructor(){super(),this._selection.onChange(e=>{this.emit("ev-data-grid-selection-change",{keys:e,rows:this.getSelectedRows()}),this.update()})}set expandRenderer(e){this._expandRenderer=e,this.expandable&&this.update()}get processCellForClipboard(){return this._processCellForClipboard}set processCellForClipboard(e){this._processCellForClipboard=e}get columns(){return this._columns}set columns(e){this._columns=Array.isArray(e)?e:[],this._dataVersion++,this.update()}get rows(){return this._rows}set rows(e){this._detachStore(),this._rows=Array.isArray(e)?e:[],this._dataVersion++,this._syncTrackedRowKeys(),this.update()}get store(){return this._store}set store(e){if(e===this._store||(this._detachStore(),this._store=e,!e))return;this._storeUnsub=e.onChange(()=>this._pullFromStore());const t=e.sort[0];t&&(this.sortColumn=t.key,this.sortDirection=t.direction),this._pullFromStore()}get undoStack(){return this._undoStack??Jr}set undoStack(e){this._undoStack=e}_detachStore(){this._storeUnsub?.(),this._storeUnsub=null,this._store=null}_pullFromStore(){this._store&&(this._rows=this._store.view(),this._dataVersion++,this._syncTrackedRowKeys(),this.update())}getSelectedRows(){return this._rows.filter((e,t)=>this._selection.isSelected(this._getRowKey(e,t)))}getSelected(){return this._selection.getSelected()}select(e){this._selection.select(e),this.update()}_getRowAtIndex(e){const t=this._getSortedRows();return e>=0&&e<t.length?t[e]:null}_getRowByKey(e){return this._rows.find((t,r)=>this._getRowKey(t,r)===e)??null}_isAllRowsSelected(){const e=this._selection.keys.length;return e>0&&this._selection.size===e}_getSortedRows(){if(this._store)return this._rows;if(!this.sortColumn)return this._rows;const e=this._columns.find(i=>i.key===this.sortColumn);if(!e||!e.sortable)return this._rows;const t=this.sortDirection==="desc"?-1:1,r=this.sortColumn;return[...this._rows].sort((i,n)=>{const a=i[r],o=n[r];return a==null?t:o==null?-t:typeof a=="number"&&typeof o=="number"?(a-o)*t:String(a).localeCompare(String(o))*t})}static styles=R`
    :host {
      display: block;
      font-family: var(--ev-font-family);
      font-size: var(--ev-font-size-sm);
      color: var(--ev-color-text-primary);
      overflow: auto;
      border: 1px solid var(--ev-color-border);
      border-radius: var(--ev-radius-md);
      background: var(--ev-color-surface-base);
    }

    /* Windowed rendering needs a bounded scroll viewport. Consumer-set
       height/max-height in the outer document overrides this default. */
    :host([virtualized]) {
      max-height: var(--ev-data-grid-max-height, 600px);
    }

    .grid-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: auto;
      min-width: 100%;
    }

    /* ── Header ───────────────────────────────── */
    thead {
      position: sticky;
      top: 0;
      z-index: var(--ev-z-raised);
    }

    th {
      position: relative;
      padding: var(--ev-space-2) var(--ev-space-3);
      background: var(--ev-color-bg-elevated);
      border-bottom: 1px solid var(--ev-color-border-strong);
      text-align: start;
      font-weight: var(--ev-font-weight-semibold);
      font-size: var(--ev-font-size-xs);
      color: var(--ev-color-text-secondary);
      text-transform: var(--ev-data-grid-header-text-transform, uppercase);
      letter-spacing: var(--ev-data-grid-header-letter-spacing, 0.04em);
      white-space: nowrap;
      user-select: none;
      line-height: var(--ev-line-height-normal);
    }

    /* Right-aligned columns: the (reserved) sort arrow sits before the label,
       so the label's edge lines up with the right-aligned values below. */
    th.align-right .th-label {
      display: inline-flex;
      flex-direction: row-reverse;
      align-items: baseline;
    }

    th.align-right .sort-arrow {
      margin-inline-start: 0;
      margin-inline-end: var(--ev-space-1);
    }

    :host([compact]) th {
      padding: var(--ev-space-1) var(--ev-space-2);
    }

    th.sortable {
      cursor: pointer;
      transition: color var(--ev-transition-fast);
    }

    th.sortable:hover {
      color: var(--ev-color-text-primary);
    }

    th.sortable:focus-visible {
      outline: 2px solid var(--ev-color-border-focus);
      outline-offset: -2px;
    }

    /* Only the active sort shows its arrow; the others appear on hover/focus
       (space stays reserved so headers never shift). */
    .sort-arrow {
      display: inline-block;
      margin-inline-start: var(--ev-space-1);
      font-size: var(--ev-font-size-2xs);
      opacity: 0;
      transition: opacity var(--ev-transition-fast);
    }

    th.sortable:hover .sort-arrow,
    th.sortable:focus-visible .sort-arrow {
      opacity: 0.6;
    }

    .sort-arrow--active {
      opacity: 1;
      color: var(--ev-color-primary);
    }

    /* ── Column resize / reorder (DG-3) ─────────── */
    /* Invisible 6px grab zone on each header cell's inline-end edge;
       pointer-capture drag adjusts the column width override. */
    .col-resize {
      position: absolute;
      top: 0;
      bottom: 0;
      inset-inline-end: 0;
      width: 6px;
      cursor: col-resize;
      z-index: 1;
      touch-action: none;
    }

    /* Insertion indicator while a header label is dragged over this th. */
    th.drop-target {
      box-shadow: inset 2px 0 0 var(--ev-color-border-focus);
    }

    /* ── Alignment ──────────────────────────────── */
    .align-left   { text-align: start; }
    .align-center { text-align: center; }
    .align-right  { text-align: end; }

    /* ── Body ───────────────────────────────────── */
    td {
      padding: var(--ev-space-2) var(--ev-space-3);
      border-bottom: 1px solid var(--ev-color-border);
      line-height: var(--ev-line-height-normal);
      vertical-align: middle;
    }

    tbody td:focus {
      outline: 2px solid var(--ev-color-border-focus);
      outline-offset: -2px;
    }

    /* Row-select mode: the row highlight shows a pointer selection; the cell
       ring is kept for keyboard focus only. */
    :host([row-select]:not([selectable])) tbody td:focus:not(:focus-visible) {
      outline: none;
    }

    :host([compact]) td {
      padding: var(--ev-space-1) var(--ev-space-2);
    }

    tr:last-child td {
      border-bottom: none;
    }

    /* ── Virtualization spacers ─────────────────── */
    tr.vspacer td {
      padding: 0;
      border: none;
    }

    tbody tr.vspacer:hover {
      background: transparent;
    }

    /* ── Striped rows ───────────────────────────── */
    /* Parity comes from the row's position in the full logical row model
       (class applied during sync), so stripes stay stable while the
       virtualized window scrolls. */
    :host([striped]) tbody tr.row--even {
      background: var(--ev-color-bg-elevated);
    }

    /* ── Row hover ──────────────────────────────── */
    tbody tr {
      transition: background var(--ev-transition-fast);
      cursor: default;
    }

    tbody tr:hover {
      background: var(--ev-state-hover-bg);
    }

    /* Selected rows (checkbox or row-select mode): tinted, with a leading accent edge. */
    tbody tr[aria-selected="true"],
    tbody tr[aria-selected="true"]:hover,
    :host([striped]) tbody tr.row--even[aria-selected="true"] {
      background: var(--ev-state-selected-bg);
    }

    tbody tr[aria-selected="true"] > td:first-child {
      box-shadow: inset 2px 0 0 var(--ev-color-primary);
    }

    :host([row-select]:not([selectable])) tbody tr[data-row-key] {
      cursor: pointer;
    }

    /* ── Selection checkbox column ──────────────── */
    .col-select {
      width: 36px;
      text-align: center;
    }

    .row-checkbox {
      appearance: none;
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      border: 1px solid var(--ev-color-border-strong);
      border-radius: var(--ev-radius-xs);
      background: var(--ev-color-bg);
      cursor: pointer;
      position: relative;
      vertical-align: middle;
      transition: border-color var(--ev-transition-fast),
                  background var(--ev-transition-fast);
    }

    .row-checkbox:hover {
      border-color: var(--ev-color-primary);
    }

    .row-checkbox:checked {
      background: var(--ev-color-primary);
      border-color: var(--ev-color-primary);
    }

    .row-checkbox:checked::after {
      content: '';
      position: absolute;
      top: 1px;
      left: 4px;
      width: 4px;
      height: 8px;
      border: solid var(--ev-color-text-on-primary);
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }

    .row-checkbox:focus-visible {
      outline: none;
      box-shadow: var(--ev-shadow-focus);
    }

    /* ── Empty state ────────────────────────────── */
    .empty {
      padding: var(--ev-space-8) var(--ev-space-4);
      text-align: center;
      color: var(--ev-color-text-tertiary);
      font-style: italic;
    }

    /* ── Cell Editing ──────────────────────────── */
    td.editable {
      cursor: text;
    }

    td.editable:hover {
      outline: 1px dashed var(--ev-color-border-focus);
      outline-offset: -1px;
    }

    .cell-editor {
      width: 100%;
      border: 1px solid var(--ev-color-border-focus);
      border-radius: var(--ev-radius-xs);
      padding: var(--ev-space-1);
      font: inherit;
      color: var(--ev-color-text-primary);
      background: var(--ev-color-surface-base);
      outline: none;
      box-shadow: var(--ev-shadow-focus);
      box-sizing: border-box;
    }

    /* Checkbox editor: intrinsic size, no full-width stretch (DG-3 pass B). */
    .cell-editor--checkbox {
      width: auto;
      box-shadow: none;
    }

    /* Failed commit-time validation: editor stays open and flags the error. */
    .cell-editor--invalid {
      border-color: var(--ev-color-danger);
      box-shadow: var(--ev-shadow-focus-danger);
    }

    /* Batch-mode dirty cell: pending value shown on a subtle accent wash. */
    td.cell--dirty {
      background: var(--ev-accent-a2);
      box-shadow: inset 2px 0 0 var(--ev-accent-8);
    }

    /* ── Row Expander ──────────────────────────── */
    .col-expand {
      width: 28px;
      text-align: center;
    }

    .expand-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border: none;
      background: transparent;
      color: var(--ev-color-text-tertiary);
      cursor: pointer;
      padding: 0;
      border-radius: var(--ev-radius-sm);
      transition: transform var(--ev-transition-fast), color var(--ev-transition-fast);
    }

    .expand-btn:hover {
      color: var(--ev-color-text-primary);
    }

    .expand-btn svg {
      width: 12px;
      height: 12px;
    }

    /* Chevron points to the inline-end (collapsed); mirror it under RTL so it
       still points "forward" in reading order without disturbing the open-state
       rotate on the button itself. */
    .expand-btn:dir(rtl) svg {
      transform: scaleX(-1);
    }

    .expand-btn--open {
      transform: rotate(90deg);
    }

    .expand-row td {
      padding: var(--ev-space-3) var(--ev-space-4);
      background: var(--ev-color-bg-sunken);
      border-bottom: 1px solid var(--ev-color-border);
    }

    /* ── Grouping ──────────────────────────────── */
    .group-header td {
      padding: var(--ev-space-2) var(--ev-space-3);
      background: var(--ev-color-surface-raised);
      font-weight: var(--ev-font-weight-semibold);
      color: var(--ev-color-text-secondary);
      cursor: pointer;
      user-select: none;
      border-bottom: 1px solid var(--ev-color-border-strong);
    }

    .group-header td:hover {
      background: var(--ev-state-hover-bg);
    }

    .group-chevron {
      display: inline-block;
      width: 12px;
      height: 12px;
      margin-inline-end: var(--ev-space-1);
      transition: transform var(--ev-transition-fast);
      vertical-align: middle;
    }

    .group-chevron--collapsed {
      transform: rotate(-90deg);
    }

    .group-count {
      font-weight: var(--ev-font-weight-normal);
      color: var(--ev-color-text-tertiary);
      margin-inline-start: var(--ev-space-1);
    }

    /* ── Frozen Columns ────────────────────────────────────────
       Each frozen cell gets its cumulative inset-inline-start set
       by _syncFrozenOffsets() (DG-3: multiple frozen columns no
       longer stack at one offset, and the logical property keeps
       them correct under dir=rtl). The last frozen column carries
       an edge border as the scroll affordance. */
    .frozen {
      position: sticky;
      inset-inline-start: 0;
      z-index: 2;
      background: inherit;
    }

    thead .frozen {
      z-index: 3;
    }

    .frozen--edge {
      border-inline-end: 1px solid var(--ev-color-border-strong);
    }
  `;get renderMode(){return"stable"}render(){return _`
      <table class="grid-table" role="grid" data-ref="table">
        <thead data-ref="head"><tr data-ref="header-row" role="row" aria-rowindex="1"></tr></thead>
        <tbody data-ref="body"></tbody>
      </table>
      <div class="empty" data-ref="empty" hidden>No columns defined</div>
    `}onConnect(){this._offLocale=Zt(()=>this.update()),this._resizeObserver=new ResizeObserver(()=>{this.hasAttribute("virtualized")&&this.update()}),this._resizeObserver.observe(this),this._store&&!this._storeUnsub&&(this._storeUnsub=this._store.onChange(()=>this._pullFromStore()),this._pullFromStore()),this.stateId&&(this._persistence=Yt(this,{stateId:`ev-data-grid:${this.stateId}`,capture:()=>this.getState(),restore:e=>this.applyState(e),captureOn:["ev-data-grid-state-change"]}))}onDisconnect(){this._offLocale?.(),this._offLocale=null,this._persistence?.detach(),this._persistence=null,this._resizeObserver?.disconnect(),this._resizeObserver=null,this._storeUnsub?.(),this._storeUnsub=null}_getModel(){const e=[this._dataVersion,this._viewVersion,this.sortColumn,this.sortDirection,this.groupBy,this.rowKey,this.expandable].join("");if(this._modelCache&&this._modelCacheKey===e)return this._modelCache;this._modelCache=this._buildModel(),this._modelCacheKey=e;const t=[];for(const r of this._modelCache)r.kind==="row"&&t.push(r.rowKey);return this._selection.setKeys(t),this._modelCache}_buildModel(){const e=this._getSortedRows(),t=[],r=(n,a)=>{const o=this._getRowKey(n,a);t.push({kind:"row",key:`r:${o}`,row:n,rowKey:o,sortedIndex:a}),this.expandable&&this._expandedRowKeys.has(o)&&t.push({kind:"expand",key:`x:${o}`,row:n,rowKey:o,sortedIndex:a})};if(!this.groupBy)return e.forEach(r),t;const i=new Map;e.forEach((n,a)=>{const o=String(n[this.groupBy]??"");i.has(o)||i.set(o,{rows:[],indices:[]}),i.get(o).rows.push(n),i.get(o).indices.push(a)});for(const[n,a]of i){const o=this._collapsedGroups.has(n);t.push({kind:"group",key:`g:${n}`,groupKey:n,count:a.rows.length,collapsed:o}),o||a.rows.forEach((c,l)=>r(c,a.indices[l]))}return t}syncDom(){const e=this.ref("table"),t=this.ref("header-row"),r=this.ref("body"),i=this.ref("empty");if(!e||!t||!r||!i)return;const n=this._orderedColumns();if(n.length===0){e.hidden=!0,i.hidden=!1,t.innerHTML="",this._headerHtml="",r.textContent="",this.toggleAttribute("virtualized",!1);return}e.hidden=!1,i.hidden=!0;const a=this._getModel(),o=n.length+(this.selectable?1:0)+(this.expandable?1:0);if(this._syncHeader(t,n),this.selectable){const u=this.query(".select-all");if(u){const b=this._selection.keys.length,g=this._selection.size;u.checked=b>0&&g===b,u.indeterminate=g>0&&g<b}}e.setAttribute("aria-rowcount",String(a.length+1)),e.setAttribute("aria-colcount",String(o));const c=a.length>=li;this.toggleAttribute("virtualized",c);const l=this.shadow.activeElement!==null&&r.contains(this.shadow.activeElement),[d,h]=this._computeWindow(a.length,c);if(this._renderWindow(r,a,d,h,n,o,c),c){const u=r.querySelector("tr[data-row-index]");if(u){const b=u.offsetHeight;b>0&&Math.abs(b-this._rowHeight)>.5&&(this._rowHeight=b)}if(h<a.length&&this.scrollHeight<=this.clientHeight+2)this._renderWindow(r,a,0,a.length,n,o,!1);else{const[b,g]=this._computeWindow(a.length,!0);(b!==d||g!==h)&&this.update()}}if(l){const u=this.shadow.activeElement;(!u||!r.contains(u))&&(this._pendingFocus=!0)}this._attachWindowListeners(),this._syncRovingFocus(r),this._syncFrozenOffsets(t,r,n),this._openPendingEditor(r)}_openPendingEditor(e){if(!this._pendingEditCell)return;const{rowKey:t,colKey:r}=this._pendingEditCell;this._pendingEditCell=null;const i=e.querySelector(`td[data-col="${CSS.escape(r)}"][data-row-key="${CSS.escape(t)}"]`);if(!i||!i.classList.contains("editable")||i.querySelector(".cell-editor"))return;const n=i.closest("tr");n instanceof HTMLElement&&this._scrollRowIntoView(n),this._startCellEdit(i)}_syncFrozenOffsets(e,t,r){const i=r.some(d=>d.frozen),n=this.ref("table");if(!i||!n){if(this._frozenActive){this._frozenActive=!1;for(const d of n?.querySelectorAll(".frozen")??[])d.classList.remove("frozen","frozen--edge"),d.style.removeProperty("inset-inline-start")}return}this._frozenActive=!0;const a=[".col-select",".col-expand"],o=r.filter(d=>d.frozen).map(d=>d.key),c=[];for(const d of a){const h=e.querySelector(d);h&&c.push({el:h,selector:d})}for(const d of o){const h=e.querySelector(`th[data-key="${d}"]`);h&&c.push({el:h,selector:`td[data-col="${d}"]`})}let l=0;c.forEach(({el:d,selector:h},u)=>{const b=u===c.length-1,g=w=>{w.classList.add("frozen"),w.classList.toggle("frozen--edge",b),w.style.insetInlineStart=`${l}px`};g(d);for(const w of t.querySelectorAll(h))g(w);l+=d.offsetWidth})}_orderedAllColumns(){if(this._columnOrder.length===0)return this._columns;const e=new Map(this._columns.map(r=>[r.key,r])),t=[];for(const r of this._columnOrder){const i=e.get(r);i&&(t.push(i),e.delete(r))}return t.push(...e.values()),t}_orderedColumns(){const e=this._orderedAllColumns();return this._hiddenColumns.size===0?e:e.filter(t=>!this._hiddenColumns.has(t.key))}setColumnVisible(e,t){t?this._hiddenColumns.delete(e):this._hiddenColumns.add(e),this.update(),this._emitStateChange()}getState(){return{columnOrder:this._orderedAllColumns().map(e=>e.key),columnWidths:{...this._columnWidths},hiddenColumns:[...this._hiddenColumns],sortColumn:this.sortColumn,sortDirection:this.sortDirection}}applyState(e){Array.isArray(e.columnOrder)&&(this._columnOrder=[...e.columnOrder]),e.columnWidths&&(this._columnWidths={...e.columnWidths}),Array.isArray(e.hiddenColumns)&&(this._hiddenColumns=new Set(e.hiddenColumns)),typeof e.sortColumn=="string"&&(this.sortColumn=e.sortColumn),typeof e.sortDirection=="string"&&(this.sortDirection=e.sortDirection),this.update()}_emitStateChange(){this.emit("ev-data-grid-state-change",this.getState())}_setColumnWidth(e,t){const r=Math.max(40,Math.round(t));this._columnWidths[e]=r;const n=this.ref("header-row")?.querySelector(`th[data-key="${CSS.escape(e)}"]`);n&&(n.style.width=`${r}px`),this.update()}_startColumnResize(e,t){const r=e.dataset.resize??"",i=e.closest("th");if(!r||!i)return;const n=getComputedStyle(this).direction==="rtl"?-1:1,a=t.clientX,o=i.offsetWidth;let c=!1;try{e.setPointerCapture(t.pointerId)}catch{}const l=h=>{const u=(h.clientX-a)*n;u===0&&!c||(c=!0,this._setColumnWidth(r,o+u))},d=()=>{e.removeEventListener("pointermove",l),e.removeEventListener("pointerup",d),e.removeEventListener("pointercancel",d),c&&this._emitStateChange()};e.addEventListener("pointermove",l),e.addEventListener("pointerup",d),e.addEventListener("pointercancel",d)}_autoFitColumn(e){const r=this.ref("header-row")?.querySelector(`th[data-key="${CSS.escape(e)}"]`),i=document.createElement("canvas").getContext("2d");if(!r||!i)return;let n=0;const a=o=>{const c=getComputedStyle(o);i.font=`${c.fontWeight} ${c.fontSize} ${c.fontFamily}`;const l=parseFloat(c.paddingInlineStart)+parseFloat(c.paddingInlineEnd);n=Math.max(n,i.measureText(o.textContent?.trim()??"").width+l)};a(r),this.ref("body")?.querySelectorAll(`td[data-col="${CSS.escape(e)}"]`).forEach(a),this._setColumnWidth(e,Math.ceil(n)+2)}_moveColumn(e,t){if(e===t)return;const r=this._columns.find(c=>c.key===e),i=this._columns.find(c=>c.key===t);if(!r||!i||!!r.frozen!=!!i.frozen)return;const n=this._orderedAllColumns().map(c=>c.key),a=n.indexOf(e),o=n.indexOf(t);a<0||o<0||(n.splice(a,1),n.splice(o,0,e),this._columnOrder=n,this.update(),this._emitStateChange())}_moveColumnBy(e,t){const r=this._orderedColumns(),i=r.findIndex(a=>a.key===e),n=i>=0?r[i+t]:void 0;n&&this._moveColumn(e,n.key)}_setDropTarget(e){this._dropTh!==e&&(this._dropTh?.classList.remove("drop-target"),this._dropTh=e,e?.classList.add("drop-target"))}_computeWindow(e,t){if(!t)return[0,e];const r=this._rowHeight,i=Math.max(this.clientHeight,r),n=Math.min(Math.floor(this.scrollTop/r),Math.max(0,e-1)),a=Math.ceil(i/r)+1,o=Math.max(0,n-Ft),c=Math.min(e,n+a+Ft);return[o,Math.max(o,c)]}_syncHeader(e,t){const r=(this.selectable?1:0)+(this.expandable?1:0),i=t.map((l,d)=>{const h=l.align?`align-${l.align}`:"align-left",u=l.sortable?"sortable":"",b=l.frozen?" frozen":"",g=l.width?_`style="width: ${l.width}"`:"";let w="",p="";if(l.sortable){const m=this.sortColumn===l.key,k=m?"sort-arrow--active":"",$=m&&this.sortDirection==="desc"?"▼":"▲";w=_`<span class="sort-arrow ${k}">${$}</span>`;const S=m?this.sortDirection==="desc"?"descending":"ascending":"none";p=_`tabindex="0" aria-sort="${S}"`}const v=l.sortable?"":_`tabindex="-1"`;return _`<th role="columnheader" aria-colindex="${r+d+1}" class="${h} ${u}${b}" data-key="${l.key}" ${p} ${v} ${g}><span class="th-label" draggable="true" data-key="${l.key}">${l.label}${w}</span><span class="col-resize" data-resize="${l.key}" aria-hidden="true"></span></th>`}),n=this.selectable&&this._isAllRowsSelected(),a=this.selectable?_`<th role="columnheader" aria-colindex="1" class="col-select"><input type="checkbox" class="row-checkbox select-all" ${n?"checked":""} aria-label="${se("grid.selectAll")}"></th>`:"",o=this.expandable?_`<th role="columnheader" aria-colindex="${this.selectable?2:1}" class="col-expand"></th>`:"",c=String(_`${a}${o}${i}`);if(c!==this._headerHtml){const l=this.shadow.activeElement,d=l instanceof HTMLElement&&e.contains(l)?l.closest("th")?.dataset.key??null:null;e.innerHTML=c,this._headerHtml=c,d&&e.querySelector(`th[data-key="${CSS.escape(d)}"]`)?.focus()}for(const l of t){const d=e.querySelector(`th[data-key="${CSS.escape(l.key)}"]`);if(!d)continue;const h=this._columnWidths[l.key];h!==void 0?d.style.width=`${h}px`:l.width||d.style.removeProperty("width")}}_renderWindow(e,t,r,i,n,a,o){this._topSpacer?.remove(),this._bottomSpacer?.remove();const c=[];if(t.length===0)c.push({key:"nodata",html:String(_`<tr data-v-key="nodata"><td colspan="${a}" class="empty">${se("common.noData")}</td></tr>`)});else for(let u=r;u<i;u++)c.push({key:t[u].key,html:this._entryHtml(t[u],u,n,a)});const l=new Map;for(const u of Array.from(e.children)){const b=u,g=b.dataset.vKey;g&&!l.has(g)?l.set(g,b):b.remove()}const d=c.map(({key:u,html:b})=>{const g=l.get(u);if(g&&this._entryHtmlCache.get(g)===b)return l.delete(u),g;g&&(l.delete(u),g.remove()),this._scratchTbody.innerHTML=b;const w=this._scratchTbody.firstElementChild;return w.remove(),this._entryHtmlCache.set(w,b),w});l.forEach(u=>u.remove());let h=e.firstElementChild;for(const u of d)u===h?h=h.nextElementSibling:e.insertBefore(u,h);if(o){const u=this._ensureSpacer("top"),b=this._ensureSpacer("bottom"),g=u.firstElementChild,w=b.firstElementChild;g.colSpan=a,w.colSpan=a,g.style.height=`${r*this._rowHeight}px`,w.style.height=`${Math.max(0,t.length-i)*this._rowHeight}px`,e.insertBefore(u,e.firstChild),e.appendChild(b)}}_ensureSpacer(e){let t=e==="top"?this._topSpacer:this._bottomSpacer;return t||(t=document.createElement("tr"),t.className="vspacer",t.setAttribute("aria-hidden","true"),t.appendChild(document.createElement("td")),e==="top"?this._topSpacer=t:this._bottomSpacer=t),t}_entryHtml(e,t,r,i){const n=t+2,a=(t+1)%2===0?"row--even":"";if(e.kind==="group"){const v=e.collapsed?"group-chevron group-chevron--collapsed":"group-chevron",m=te(`<svg class="${v}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`);return String(_`<tr class="group-header" role="row" data-v-key="${e.key}" data-group="${e.groupKey}" aria-rowindex="${n}"><td role="gridcell" aria-colindex="1" tabindex="-1" colspan="${i}">${m}${e.groupKey}<span class="group-count">(${e.count})</span></td></tr>`)}if(e.kind==="expand"){const v=this._expandRenderer?te(this._expandRenderer(e.row)):_`<pre>${JSON.stringify(e.row,null,2)}</pre>`;return String(_`<tr class="expand-row" role="row" data-v-key="${e.key}" aria-rowindex="${n}"><td role="gridcell" aria-colindex="1" tabindex="-1" colspan="${i}">${v}</td></tr>`)}const{row:o,rowKey:c,sortedIndex:l}=e,d=te('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'),h=(this.selectable?1:0)+(this.expandable?1:0),u=this.selectable?_`<td role="gridcell" aria-colindex="1" tabindex="-1" class="col-select"><input type="checkbox" tabindex="-1" class="row-checkbox row-select" data-row-key="${c}" ${this._selection.isSelected(c)?"checked":""} aria-label="${se("grid.selectRow")} ${l+1}"></td>`:"",b=this.expandable?_`<td role="gridcell" aria-colindex="${this.selectable?2:1}" tabindex="-1" class="col-expand"><button class="expand-btn ${this._expandedRowKeys.has(c)?"expand-btn--open":""}" tabindex="-1" data-row-key="${c}" data-expand="${l}" type="button" aria-label="${se("grid.toggleDetails")}">${d}</button></td>`:"",g=this._pendingEdits.get(c),w=r.map((v,m)=>{const k=v.align?`align-${v.align}`:"align-left",$=v.frozen?" frozen":"",S=this.editable&&v.editable!==!1||v.editable?" editable":"",y=g!==void 0&&g.has(v.key),f=y?" cell--dirty":"",M=y?g.get(v.key):o[v.key],L=M==null?"":String(M),K=v.renderCell?te(v.renderCell(M,o,v)):L;return _`<td role="gridcell" aria-colindex="${h+m+1}" tabindex="-1" class="${k}${$}${S}${f}" data-col="${v.key}" data-row="${l}" data-row-key="${c}">${K}</td>`}),p=this.selectable||this.rowSelect?_`aria-selected="${this._selection.isSelected(c)?"true":"false"}"`:"";return String(_`<tr class="${a}" role="row" data-v-key="${e.key}" data-row-index="${l}" data-row-key="${c}" aria-rowindex="${n}" ${p}>${u}${b}${w}</tr>`)}bindEvents(){const e=this.ref("head"),t=this.ref("body");this.listen(e,"click",r=>{const i=r.target;if(i.closest(".col-resize"))return;const n=i.closest("th.sortable");n?.dataset.key&&this._toggleSort(n.dataset.key)}),this.listen(e,"keydown",r=>{const i=r,n=i.target.closest("th[data-key]");if(!n?.dataset.key)return;const a=n.dataset.key,o=i.key==="ArrowRight"||i.key==="ArrowLeft";if(i.altKey&&o){i.preventDefault();const c=this._columnWidths[a]??n.offsetWidth;this._setColumnWidth(a,c+(i.key==="ArrowRight"?8:-8)),this._emitStateChange();return}if(i.ctrlKey&&i.shiftKey&&o){i.preventDefault(),this._moveColumnBy(a,i.key==="ArrowRight"?1:-1);return}i.key!=="Enter"&&i.key!==" "||n.classList.contains("sortable")&&(i.preventDefault(),this._toggleSort(a))}),this.listen(e,"pointerdown",r=>{const i=r,n=i.target.closest(".col-resize");n?.dataset.resize&&(i.preventDefault(),this._startColumnResize(n,i))}),this.listen(e,"dblclick",r=>{const i=r.target.closest(".col-resize");i?.dataset.resize&&(r.stopPropagation(),this._autoFitColumn(i.dataset.resize),this._emitStateChange())}),this.listen(e,"dragstart",r=>{const i=r,n=i.target.closest(".th-label");n?.dataset.key&&(this._dragColKey=n.dataset.key,i.dataTransfer?.setData("text/plain",n.dataset.key),i.dataTransfer&&(i.dataTransfer.effectAllowed="move"))}),this.listen(e,"dragover",r=>{if(!this._dragColKey)return;const i=r.target.closest("th[data-key]");if(!i)return;r.preventDefault();const n=r;n.dataTransfer&&(n.dataTransfer.dropEffect="move"),this._setDropTarget(i)}),this.listen(e,"drop",r=>{const i=this._dragColKey,n=r.target.closest("th[data-key]");this._dragColKey=null,this._setDropTarget(null),!(!i||!n?.dataset.key)&&(r.preventDefault(),this._moveColumn(i,n.dataset.key))}),this.listen(e,"dragend",()=>{this._dragColKey=null,this._setDropTarget(null)}),this.listen(t,"focusin",r=>{const n=r.target.closest("td"),a=n?.closest("tr");!n||!a||!a.dataset.vKey||(this._focusEntryKey=a.dataset.vKey,this._focusColIndex=Array.prototype.indexOf.call(a.children,n),this._setRovingCell(n))}),this.listen(t,"keydown",r=>this._onBodyKeydown(r)),this.listen(t,"click",r=>{const i=r.target,n=i.closest("tr.group-header");if(n){const h=n.dataset.group??"";this._collapsedGroups.has(h)?this._collapsedGroups.delete(h):this._collapsedGroups.add(h),this._viewVersion++,this.update();return}const a=i.closest(".expand-btn");if(a&&this.expandable){r.stopPropagation();const h=Number(a.dataset.expand),u=a.dataset.rowKey??"",b=this._getRowByKey(u)??this._getRowAtIndex(h);if(!b)return;this._expandedRowKeys.has(u)?this._expandedRowKeys.delete(u):this._expandedRowKeys.add(u),this._viewVersion++,this.emit("ev-data-grid-expand",{index:h,key:u,row:b,expanded:this._expandedRowKeys.has(u)}),this.update();return}if(i.classList.contains("row-select")||i.closest(".cell-editor"))return;const o=i.closest("tr[data-row-index]");if(!o)return;const c=Number(o.dataset.rowIndex),l=o.dataset.rowKey??"",d=this._getRowByKey(l)??this._getRowAtIndex(c);if(!this.selectable&&this.rowSelect&&l)this._selection.select([l]);else if(this.selectable&&l){const h=r;i.closest(".col-select")?this._selection.toggleAt(l):this._selection.click(l,{shift:h.shiftKey,ctrl:ce(h)})}d&&this.emit("ev-data-grid-row-click",{row:d,index:c})}),this.listen(t,"dblclick",r=>{const i=r.target.closest("td.editable");!i||i.querySelector(".cell-editor")||this._startCellEdit(i)}),this.listen(this,"scroll",()=>{if(!this.hasAttribute("virtualized"))return;const r=Math.floor(this.scrollTop/this._rowHeight);r!==this._lastScrollBucket&&(this._lastScrollBucket=r,this.update())})}_attachWindowListeners(){if(!this.selectable)return;this.queryAll(".row-select").forEach(t=>{this.listen(t,"change",()=>{const r=t.dataset.rowKey??"";r&&t.checked!==this._selection.isSelected(r)&&this._selection.toggleAt(r)})});const e=this.query(".select-all");e&&this.listen(e,"change",()=>{e.checked?this._selection.selectAll():this._selection.clear()})}_toggleSort(e){this._columns.find(r=>r.key===e)?.sortable&&(this.sortColumn===e?this.sortDirection=this.sortDirection==="asc"?"desc":"asc":(this.sortColumn=e,this.sortDirection="asc"),this._store?.setSort([{key:this.sortColumn,direction:this.sortDirection==="desc"?"desc":"asc"}]),this.emit("ev-data-grid-sort",{column:this.sortColumn,direction:this.sortDirection}),this._emitStateChange(),this.update())}_onBodyKeydown(e){const t=e.target;if(t.closest(".cell-editor"))return;const r=t.closest("td"),i=r?.closest("tr");if(!r||!i||!i.dataset.vKey)return;const n=this._getModel();if(n.length===0)return;const a=Number(i.getAttribute("aria-rowindex")??"0")-2,o=Array.prototype.indexOf.call(i.children,r),c=this._orderedColumns().length+(this.selectable?1:0)+(this.expandable?1:0)-1,l=n.length-1;if(this.selectable&&ce(e)&&(e.key==="a"||e.key==="A")){e.preventDefault(),this._selection.selectAll();return}if(ce(e)&&(e.key==="c"||e.key==="C")){this._copyToClipboard(r)&&e.preventDefault();return}if(ce(e)&&(e.key==="v"||e.key==="V")){this._pasteFromClipboard(r);return}switch(e.key){case"ArrowRight":case"ArrowLeft":{e.preventDefault();const d=getComputedStyle(this).direction==="rtl",h=e.key==="ArrowRight"!==d;this._focusCell(a,h?Math.min(o+1,c):o-1);return}case"ArrowDown":e.preventDefault(),this._focusCell(a+1,o),this._navigateSelection(a+1,e);return;case"ArrowUp":e.preventDefault(),this._focusCell(a-1,o),this._navigateSelection(a-1,e);return;case"Home":e.preventDefault(),e.ctrlKey||e.metaKey?this._focusCell(0,0):this._focusCell(a,0);return;case"End":e.preventDefault(),e.ctrlKey||e.metaKey?this._focusCell(l,c):this._focusCell(a,c);return;case"PageDown":e.preventDefault(),this._focusCell(a+this._pageSize(),o);return;case"PageUp":e.preventDefault(),this._focusCell(a-this._pageSize(),o);return;case" ":{if(!this.selectable)return;const d=i.dataset.rowKey;if(!d)return;e.preventDefault(),this._selection.toggleAt(d);return}case"Enter":case"F2":{if(r.classList.contains("editable")&&!r.querySelector(".cell-editor")){e.preventDefault(),this._startCellEdit(r);return}const d=r.querySelector(".expand-btn");e.key==="Enter"&&d&&(e.preventDefault(),d.click());return}}}_navigateSelection(e,t){if(!this.selectable)return;const r=this._getModel();if(r.length===0)return;const i=Math.max(0,Math.min(e,r.length-1)),n=r[i];n.kind==="row"&&this._selection.navigate(n.rowKey,{shift:t.shiftKey,ctrl:ce(t)})}_pageSize(){const e=this.ref("head")?.offsetHeight??0,t=Math.max(this.clientHeight-e,this._rowHeight);return Math.max(1,Math.floor(t/this._rowHeight)-1)}_focusCell(e,t){const r=this._getModel();if(r.length===0)return;const i=Math.max(0,Math.min(e,r.length-1)),n=r[i];this._focusEntryKey=n.key,this._focusColIndex=Math.max(0,t);const o=this.ref("body")?.querySelector(`tr[data-v-key="${CSS.escape(n.key)}"]`);if(o){const h=o.children,u=h[Math.min(this._focusColIndex,h.length-1)];u&&(this._setRovingCell(u),u.focus({preventScroll:!0}),this._scrollRowIntoView(o));return}this._pendingFocus=!0;const c=this.ref("head")?.offsetHeight??0,l=c+i*this._rowHeight,d=l+this._rowHeight;l<this.scrollTop+c?this.scrollTop=Math.max(0,l-c):d>this.scrollTop+this.clientHeight&&(this.scrollTop=d-this.clientHeight),this.update()}_scrollRowIntoView(e){const t=this.ref("head")?.offsetHeight??0,r=e.offsetTop,i=r+e.offsetHeight;r-t<this.scrollTop?this.scrollTop=Math.max(0,r-t):i>this.scrollTop+this.clientHeight&&(this.scrollTop=i-this.clientHeight)}_setRovingCell(e){this._rovingTd!==e&&(this._rovingTd&&this._rovingTd.isConnected&&(this._rovingTd.tabIndex=-1),e.tabIndex=0,this._rovingTd=e)}_syncRovingFocus(e){let t=null;if(this._focusEntryKey){const r=e.querySelector(`tr[data-v-key="${CSS.escape(this._focusEntryKey)}"]`);if(r){const i=r.children;t=i[Math.min(this._focusColIndex,i.length-1)]??null}else if(this.hasAttribute("virtualized")){const i=e.querySelector("tr[data-v-key] > td");i&&this._setRovingCell(i);return}else this._focusEntryKey=null,this._pendingFocus=!1}if(t||(t=e.querySelector("tr[data-v-key] > td"),this._pendingFocus=!1),!t){this._pendingFocus=!1;return}if(this._setRovingCell(t),this._pendingFocus){this._pendingFocus=!1,t.focus({preventScroll:!0});const r=t.parentElement;r instanceof HTMLElement&&this._scrollRowIntoView(r)}}_startCellEdit(e){const t=e.dataset.col,r=Number(e.dataset.row),i=e.dataset.rowKey??"";if(!t)return;const n=this._columns.find(v=>v.key===t),a=n?.editor??"text",o=this._getRowByKey(i)??this._getRowAtIndex(r),c=this._pendingEdits.get(i),l=c?.has(t)?c.get(t):o?.[t]??null;e.textContent="";let d;if(a==="select"){const v=document.createElement("select");v.className="cell-editor";for(const m of n?.editorOptions??[]){const k=document.createElement("option");k.value=m.value,k.textContent=m.label,v.appendChild(k)}v.value=l==null?"":String(l),d=v}else if(a==="checkbox"){const v=document.createElement("input");v.type="checkbox",v.className="cell-editor cell-editor--checkbox",v.checked=l===!0||l==="true",d=v}else{const v=document.createElement("input");v.type=a==="number"?"number":"text",v.className="cell-editor",v.value=l==null?"":String(l),d=v}e.appendChild(d),d.focus(),d instanceof HTMLInputElement&&a!=="checkbox"&&d.select();const h=()=>{if(a==="checkbox")return d.checked;if(a==="number"){const v=d.valueAsNumber;return Number.isNaN(v)?null:v}return d.value};let u=!1,b=!1;const g=()=>{const v=e.closest("tr");v&&this._entryHtmlCache.delete(v),this.update()},w=()=>{if(u||b)return!1;const v=h();if(n?.validate&&o){const m=n.validate(v,o);if(m!=null)return d.classList.add("cell-editor--invalid"),d.setAttribute("aria-invalid","true"),d.title=m,this.emit("ev-data-grid-validation-error",{row:o,column:t,value:v,message:m}),!1;d.classList.remove("cell-editor--invalid"),d.removeAttribute("aria-invalid"),d.removeAttribute("title")}return u=!0,o&&v!==l&&this._applyEdit(o,i,t,v,r),g(),!0},p=()=>{b=!0,!u&&(u=!0,g())};d.addEventListener("keydown",v=>{const m=v;m.key==="Enter"?(m.preventDefault(),m.stopPropagation(),w()&&this._queueEditNeighbor(i,t,"down")):m.key==="Tab"?(m.preventDefault(),m.stopPropagation(),w()&&this._queueEditNeighbor(i,t,m.shiftKey?"prev":"next")):m.key==="Escape"&&(m.preventDefault(),m.stopPropagation(),p())}),a==="checkbox"&&d.addEventListener("change",()=>w()),d.addEventListener("blur",()=>w())}_applyEdit(e,t,r,i,n){let a=e;if(this.editMode==="batch"){let o=this._pendingEdits.get(t);i===(e[r]??null)?(o?.delete(r),o&&o.size===0&&this._pendingEdits.delete(t)):(o||(o=new Map,this._pendingEdits.set(t,o)),o.set(r,i))}else{const o=e[r]??null;this._store&&this._store.update(t,{[r]:i})?a=this._store.getByKey(t)??e:(e[r]=i,this._dataVersion++),this._pushUndoUnit(t,r,o,i)}this.emit("ev-data-grid-cell-edit",{row:a,column:r,value:i,index:n})}_setCellValue(e,t,r){if(this._store){this._store.update(e,{[t]:r});return}const i=this._getRowByKey(e);i&&(i[t]=r,this._dataVersion++,this.update())}_pushUndoUnit(e,t,r,i){if(!this.undoable)return;const n=this._columns.find(a=>a.key===t)?.label??t;this.undoStack.push({label:`Edit ${n}`,undo:()=>this._setCellValue(e,t,r),redo:()=>this._setCellValue(e,t,i)})}_isColEditable(e){return this.editable&&e.editable!==!1||e.editable===!0}_queueEditNeighbor(e,t,r){const i=c=>this._isColEditable(c);if(r==="down"){const c=this._getModel(),l=c.findIndex(d=>d.kind==="row"&&d.rowKey===e);if(l<0)return;for(let d=l+1;d<c.length;d++){const h=c[d];if(h.kind==="row"){this._pendingEditCell={rowKey:h.rowKey,colKey:t};return}}return}const n=this._orderedColumns().filter(i),a=n.findIndex(c=>c.key===t);if(a<0)return;const o=n[r==="next"?a+1:a-1];o&&(this._pendingEditCell={rowKey:e,colKey:o.key})}getPendingEdits(){const e=[];for(const[t,r]of this._pendingEdits){const i=this._getRowByKey(t);for(const[n,a]of r)e.push({rowKey:t,columnKey:n,oldValue:i?i[n]??null:null,value:a})}return e}commitEdits(){if(this._pendingEdits.size===0)return;const e=this.getPendingEdits(),t=()=>{for(const r of e){if(this._store)this._store.update(r.rowKey,{[r.columnKey]:r.value});else{const i=this._getRowByKey(r.rowKey);i&&(i[r.columnKey]=r.value)}this._pushUndoUnit(r.rowKey,r.columnKey,r.oldValue,r.value)}};this.undoable?this.undoStack.group("Commit Edits",t):t(),this._pendingEdits.clear(),this._dataVersion++,this.emit("ev-data-grid-edits-commit",{edits:e}),this.update()}revertEdits(){if(this._pendingEdits.size===0)return;const e=this.getPendingEdits();this._pendingEdits.clear(),this.emit("ev-data-grid-edits-revert",{edits:e}),this.update()}_displayedValue(e,t,r){const i=this._pendingEdits.get(t);return i?.has(r)?i.get(r):e[r]??null}_clipboardCellText(e,t,r){const i=this._displayedValue(e,t,r.key);return this._processCellForClipboard?this._processCellForClipboard(i,e,r):i==null?"":String(i)}_copyToClipboard(e){const t=this._orderedColumns();if(t.length===0)return!1;const r=this._getModel().filter(o=>o.kind==="row"&&this._selection.isSelected(o.rowKey));let i,n,a;if(r.length>0)i=r.map(o=>t.map(c=>this._clipboardCellText(o.row,o.rowKey,c)).join("	")).join(`
`),n=r.length,a=t.length;else{const o=e.dataset.col??"",c=e.dataset.rowKey??"",l=t.find(h=>h.key===o),d=this._getRowByKey(c);if(!l||!d)return!1;i=this._clipboardCellText(d,c,l),n=1,a=1}return this._writeClipboard(i),this.emit("ev-data-grid-clipboard-copy",{rowCount:n,columnCount:a,text:i}),!0}_writeClipboard(e){const t=()=>{const r=this.shadow.activeElement,i=document.createElement("textarea");i.value=e,i.setAttribute("aria-hidden","true"),i.style.position="fixed",i.style.opacity="0",document.body.appendChild(i),i.select();try{document.execCommand("copy")}catch{}i.remove(),r?.focus()};try{navigator.clipboard.writeText(e).catch(t)}catch{t()}}async _pasteFromClipboard(e){const t=e.dataset.col??"",r=e.dataset.rowKey??"",i=this._orderedColumns(),n=i.findIndex(w=>w.key===t);if(n<0||!r||!this._isColEditable(i[n]))return;let a="";try{a=await navigator.clipboard.readText()}catch{return}if(!a)return;const o=i.slice(n),c=this._getModel(),l=c.findIndex(w=>w.kind==="row"&&w.rowKey===r);if(l<0)return;const d=c.slice(l).filter(w=>w.kind==="row"),h=a.replace(/\r\n?/g,`
`).replace(/\n+$/,"").split(`
`);let u=0,b=0;const g=()=>{h.forEach((w,p)=>{const v=d[p];v&&w.split("	").forEach((m,k)=>{const $=o[k];if(!$)return;if(!this._isColEditable($)){b++;return}const S=this._coercePasteValue($,m);if($.validate){const y=$.validate(S,v.row);if(y!=null){b++;return}}this._applyEdit(v.row,v.rowKey,$.key,S,v.sortedIndex),u++})})};this.undoable?this.undoStack.group("Paste",g):g(),this.emit("ev-data-grid-clipboard-paste",{applied:u,skipped:b}),this.update()}_coercePasteValue(e,t){if(e.editor==="number"){const r=t.trim(),i=Number(r);return r!==""&&!Number.isNaN(i)?i:t}if(e.editor==="checkbox"){const r=t.trim().toLowerCase();return r==="true"||r==="1"?!0:r==="false"||r==="0"?!1:t}return t}exportCsv(e){const t=this._orderedColumns(),r=o=>/[",\n\r]/.test(o)?`"${o.replace(/"/g,'""')}"`:o,i=(o,c,l)=>{const d=this._displayedValue(o,c,l.key);return d==null?"":String(d)},n=[t.map(o=>r(o.label)).join(",")];for(const o of this._getModel())o.kind==="row"&&(e?.selectedOnly&&!this._selection.isSelected(o.rowKey)||n.push(t.map(c=>r(i(o.row,o.rowKey,c))).join(",")));const a=n.join(`\r
`);if(e?.fileName){const o=URL.createObjectURL(new Blob([a],{type:"text/csv"})),c=document.createElement("a");c.href=o,c.download=e.fileName,c.click(),URL.revokeObjectURL(o)}return a}_getRowKey(e,t){const r=this.rowKey?e[this.rowKey]:void 0;if(r!=null&&r!=="")return String(r);const i=this._rowIdentityKeys.get(e);if(i)return i;const n=`row-${this._nextGeneratedRowKey++}`;return this._rowIdentityKeys.set(e,n),n}_syncTrackedRowKeys(){const e=new Set(this._rows.map((t,r)=>this._getRowKey(t,r)));this._expandedRowKeys.forEach(t=>{e.has(t)||this._expandedRowKeys.delete(t)});for(const t of[...this._pendingEdits.keys()])e.has(t)||this._pendingEdits.delete(t)}}I("ev-data-grid",di);class hi extends A{static props={position:{type:"string",reflect:!0,default:"right"},detailWidth:{type:"number",reflect:!0,default:300},minWidth:{type:"number",reflect:!0,default:120},open:{type:"boolean",reflect:!0,default:!1}};static styles=R`
    :host {
      display: block;
      height: 100%;
      overflow: hidden;
      font-family: var(--ev-font-family);
      font-size: var(--ev-font-size-sm);
      color: var(--ev-detail-panel-color, var(--ev-color-text-primary));
      background: var(--ev-detail-panel-bg, var(--ev-color-surface-base));
    }

    .layout {
      display: flex;
      height: 100%;
      overflow: hidden;
    }

    :host([position="bottom"]) .layout {
      flex-direction: column;
    }

    .master {
      flex: 1;
      overflow: auto;
      min-width: 0;
      min-height: 0;
    }

    .master::-webkit-scrollbar {
      width: 6px;
    }
    .master::-webkit-scrollbar-track {
      background: transparent;
    }
    .master::-webkit-scrollbar-thumb {
      background: var(--ev-scrollbar-thumb);
      border-radius: var(--ev-radius-full);
    }

    .divider {
      flex-shrink: 0;
      background: var(--ev-color-border);
      /* Own the drag gesture (touch pan would otherwise scroll and cancel it). */
      touch-action: none;
      transition: background var(--ev-transition-fast);
    }

    .divider:hover,
    .divider--active {
      background: var(--ev-color-primary);
    }

    .divider:focus-visible {
      outline: none;
      box-shadow: var(--ev-shadow-focus);
    }

    :host([position="right"]) .divider {
      width: var(--ev-detail-panel-divider-size, 4px);
      cursor: col-resize;
    }

    :host([position="bottom"]) .divider {
      height: var(--ev-detail-panel-divider-size, 4px);
      cursor: row-resize;
    }

    .detail {
      overflow: auto;
      flex-shrink: 0;
      background: var(--ev-detail-panel-detail-bg, var(--ev-color-bg-elevated));
    }

    .detail::-webkit-scrollbar {
      width: 6px;
    }
    .detail::-webkit-scrollbar-track {
      background: transparent;
    }
    .detail::-webkit-scrollbar-thumb {
      background: var(--ev-scrollbar-thumb);
      border-radius: var(--ev-radius-full);
    }

    .detail.hidden {
      display: none;
    }

    .divider.hidden {
      display: none;
    }
  `;render(){const e=this.open,t=e?"":"hidden",r=this.position==="bottom"?"horizontal":"vertical";return _`
      <div class="layout">
        <div class="master">
          <slot></slot>
        </div>
        <div class="divider ${t}" role="separator" tabindex="${e?"0":"-1"}"
          aria-orientation="${r}" aria-label="Resize detail panel"
          aria-valuenow="${String(Math.round(this.detailWidth))}"
          aria-valuemin="${String(this.minWidth)}" aria-valuemax="${String(this._maxWidth())}"></div>
        <div class="detail ${t}" role="region" aria-label="Detail">
          <slot name="detail"></slot>
        </div>
      </div>
    `}bindEvents(){const e=this.query(".detail");e&&this.open&&(this.position==="bottom"?(e.style.height=`${this.detailWidth}px`,e.style.width=""):(e.style.width=`${this.detailWidth}px`,e.style.height=""));const t=this.query(".divider");this.listen(t,"pointerdown",this._onDividerPointerDown),this.listen(t,"keydown",this._onDividerKeyDown)}get _isBottom(){return this.position==="bottom"}_maxWidth(){const e=this.getBoundingClientRect(),t=this._isBottom?e.height:e.width;return Math.max(this.minWidth,Math.round(t-this.minWidth))||600}_setWidth(e){const t=Math.max(this.minWidth,Math.min(e,this._maxWidth()));if(t===this.detailWidth)return;this._propStore.set("detailWidth",t);const r=this.query(".detail");r&&(this._isBottom?r.style.height=`${t}px`:r.style.width=`${t}px`),this.query(".divider")?.setAttribute("aria-valuenow",String(Math.round(t))),this.emit("ev-detail-panel-resize",{detailWidth:t})}_onDividerPointerDown=e=>{if(!this.open)return;e.preventDefault();const t=e.currentTarget;try{t.setPointerCapture(e.pointerId)}catch{}t.classList.add("divider--active");const r=this.getBoundingClientRect(),i=a=>{const o=this._isBottom?r.bottom-a.clientY:r.right-a.clientX;this._setWidth(o)},n=()=>{t.classList.remove("divider--active"),t.removeEventListener("pointermove",i),t.removeEventListener("pointerup",n),t.removeEventListener("pointercancel",n)};t.addEventListener("pointermove",i),t.addEventListener("pointerup",n),t.addEventListener("pointercancel",n)};_onDividerKeyDown=e=>{if(!this.open)return;const t=e.shiftKey?40:10;let r=0;switch(e.key){case"ArrowLeft":r=this._isBottom?0:t;break;case"ArrowRight":r=this._isBottom?0:-t;break;case"ArrowUp":r=this._isBottom?t:0;break;case"ArrowDown":r=this._isBottom?-t:0;break;case"Home":e.preventDefault(),this._setWidth(this.minWidth);return;case"End":e.preventDefault(),this._setWidth(this._maxWidth());return;default:return}r!==0&&(e.preventDefault(),this._setWidth(this.detailWidth+r))};show(){this.open||(this.open=!0,this.emit("ev-detail-panel-open"))}hide(){this.open&&(this.open=!1,this.emit("ev-detail-panel-close"))}}I("ev-detail-panel",hi);class ui extends A{static props={value:{type:"string",reflect:!0,default:""},placeholder:{type:"string",reflect:!0,default:"Search..."},debounce:{type:"number",reflect:!0,default:250},size:{type:"string",reflect:!0,default:"md"},disabled:{type:"boolean",reflect:!0,default:!1},fullWidth:{type:"boolean",reflect:!0,default:!1},loading:{type:"boolean",reflect:!0,default:!1}};_debouncedEmit=null;_debounceValue=NaN;static styles=R`
    :host {
      display: inline-flex;
      font-family: var(--ev-font-family);
    }

    ${er}
    ${ht}
    ${tr}
    ${ss}

    .wrapper {
      gap: var(--ev-search-gap, var(--ev-space-2));
      width: 100%;
    }

    .icon {
      width: var(--ev-control-icon-size);
      height: var(--ev-control-icon-size);
      color: var(--ev-color-text-tertiary);
      flex-shrink: 0;
    }

    /* Busy spinner replaces the search icon while a query is pending. */
    .search-spinner {
      display: none;
      width: var(--ev-control-icon-size);
      height: var(--ev-control-icon-size);
      border: 2px solid var(--ev-color-border-strong);
      border-right-color: transparent;
      border-radius: 50%;
      flex-shrink: 0;
      animation: ev-search-spin 0.6s linear infinite;
    }

    :host([loading]) .icon { display: none; }
    :host([loading]) .search-spinner { display: block; }

    @keyframes ev-search-spin {
      to { transform: rotate(360deg); }
    }

    input {
      flex: 1;
      border: none;
      outline: none;
      background: transparent;
      color: var(--ev-color-text-primary);
      font: inherit;
      min-width: 0;
    }

    input::placeholder {
      color: var(--ev-color-text-tertiary);
    }

    .clear {
      display: flex;
      align-items: center;
      justify-content: center;
      width: var(--ev-control-icon-size);
      height: var(--ev-control-icon-size);
      border: none;
      background: var(--ev-color-secondary-subtle);
      border-radius: var(--ev-radius-full);
      cursor: pointer;
      color: var(--ev-color-text-tertiary);
      font-size: var(--ev-font-size-2xs);
      line-height: 1;
      padding: 0;
      transition: background var(--ev-transition-fast), color var(--ev-transition-fast);
    }

    .clear:hover {
      background: var(--ev-color-border-strong);
      color: var(--ev-color-text-primary);
    }

    .clear--hidden {
      display: none;
    }
  `;get renderMode(){return"stable"}render(){return _`
      <div class="wrapper" data-ref="wrapper">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <span class="search-spinner" aria-hidden="true"></span>
        <input data-ref="input" type="text" />
        <button class="clear clear--hidden" data-ref="clear" type="button" aria-label="Clear search">&times;</button>
      </div>
    `}bindEvents(){const e=this.ref("input"),t=this.ref("clear");e&&(this.listen(e,"focus",()=>{this.emit("ev-search-focus")}),this.listen(e,"blur",()=>{this.emit("ev-search-blur")}),this.listen(e,"input",()=>{this.value=e.value,t?.classList.toggle("clear--hidden",!e.value),this._ensureDebounce(),this._debouncedEmit?.()}),this.listen(e,"keydown",r=>{const i=r;i.key==="Enter"&&(this._debouncedEmit?.cancel(),this.emit("ev-search-submit",{value:this.value})),i.key==="Escape"&&this.value&&(i.preventDefault(),this._clear(e,t))}),t&&this.listen(t,"click",()=>{this._clear(e,t)}))}syncDom(){const e=this.ref("input"),t=this.ref("clear");e&&(e.value!==this.value&&(e.value=this.value),e.placeholder=this.placeholder,e.setAttribute("aria-label",this.placeholder),e.setAttribute("aria-busy",String(this.loading)),e.disabled=this.disabled,t?.classList.toggle("clear--hidden",!this.value),this._ensureDebounce())}_clear(e,t){this._debouncedEmit?.cancel(),this.value="",e.value="",t?.classList.add("clear--hidden"),e.focus(),this.emit("ev-search-input",{value:""}),this.emit("ev-search-submit",{value:""})}_ensureDebounce(){this._debounceValue===this.debounce&&this._debouncedEmit||(this._debounceValue=this.debounce,this._debouncedEmit?.cancel(),this._debouncedEmit=rs(()=>{this.emit("ev-search-input",{value:this.value})},this.debounce))}onDisconnect(){this._debouncedEmit?.cancel(),this._debouncedEmit=null,this._debounceValue=NaN}focus(e){this.ref("input")?.focus(e)}blur(){this.ref("input")?.blur()}}I("ev-search",ui);class vi extends Gt{static props={value:{type:"string",reflect:!0,default:""},name:{type:"string",reflect:!0,default:""},disabled:{type:"boolean",reflect:!0,default:!1},required:{type:"boolean",reflect:!0,default:!1},size:{type:"string",reflect:!0,default:"md"}};_options=[];get options(){return this._options}set options(e){this._options=e,this.update()}static styles=R`
    :host {
      display: inline-flex;
      font-family: var(--ev-font-family);
    }

    [data-ev-root] {
      display: contents;
    }

    :host([disabled]) {
      opacity: var(--ev-state-disabled-opacity, 0.5);
      pointer-events: none;
    }

    .segment-group {
      display: flex;
      border: var(--ev-segmented-button-border, 1px solid var(--ev-color-border));
      border-radius: var(--ev-segmented-button-radius, var(--ev-radius-control));
      overflow: hidden;
      background: var(--ev-segmented-button-bg, var(--ev-color-surface-base));
    }

    .segment {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--ev-space-1);
      border: none;
      background: transparent;
      color: var(--ev-color-text-secondary);
      cursor: pointer;
      font: inherit;
      font-weight: var(--ev-font-weight-medium);
      padding: var(--ev-segmented-button-segment-padding, 0 var(--ev-space-3));
      transition: background var(--ev-transition-fast), color var(--ev-transition-fast);
      position: relative;
    }

    .segment + .segment {
      border-inline-start: 1px solid var(--ev-color-border);
    }

    .segment:hover {
      background: var(--ev-state-hover-bg);
      color: var(--ev-color-text-primary);
    }

    .segment--active {
      background: var(--ev-color-primary);
      color: var(--ev-color-text-on-primary);
    }

    .segment--active:hover {
      background: var(--ev-color-primary-hover);
      color: var(--ev-color-text-on-primary);
    }

    .segment--disabled {
      opacity: var(--ev-state-disabled-opacity, 0.5);
      pointer-events: none;
    }

    .segment:focus-visible {
      outline: none;
      box-shadow: var(--ev-shadow-focus);
      z-index: 1;
    }

    :host([size="sm"]) .segment { height: var(--ev-size-sm); font-size: var(--ev-font-size-xs); padding: 0 var(--ev-space-2); }
    :host([size="md"]) .segment,
    :host(:not([size])) .segment { height: var(--ev-size-md); font-size: var(--ev-font-size-sm); }
    :host([size="lg"]) .segment { height: var(--ev-size-lg); font-size: var(--ev-font-size-base); padding: 0 var(--ev-space-4); }
  `;_renderedOptionsKey="";_roving=new ts({getItems:()=>this.queryAll(".segment"),isDisabled:e=>e.classList.contains("segment--disabled"),selectOnMove:!0,onActivate:e=>this._select(e)});get renderMode(){return"stable"}render(){return _`<div class="segment-group" data-ref="group" role="radiogroup"></div>`}syncDom(){const e=this.ref("group");if(!e)return;const t=this.getAttribute("aria-label")?.trim();t?e.setAttribute("aria-label",t):e.removeAttribute("aria-label");const r=JSON.stringify(this._options);if(r!==this._renderedOptionsKey){this._renderedOptionsKey=r;const a=this.shadow.activeElement?.dataset?.value;e.innerHTML=String(_`${this._options.map(o=>{const c=["segment"];o.disabled&&c.push("segment--disabled");const l=o.icon?_`<span class="segment-icon">${o.icon}</span>`:"";return _`<button class="${c.join(" ")}" data-value="${o.value}" type="button" role="radio" aria-checked="false">${l}${o.label}</button>`})}`),a!==void 0&&e.querySelector(`[data-value="${CSS.escape(a)}"]`)?.focus()}let i=-1;e.querySelectorAll(".segment").forEach((a,o)=>{const c=(a.dataset.value??"")===this.value;c&&(i=o),a.classList.toggle("segment--active",c),a.setAttribute("aria-checked",String(c))}),this._roving.sync(i>=0?i:void 0)}bindEvents(){const e=this.ref("group");e&&(this.listen(e,"click",t=>{const r=t.target.closest(".segment");!r||r.classList.contains("segment--disabled")||this._select(r)}),this.listen(e,"keydown",t=>this._roving.handleKeydown(t)),this.listen(e,"focusin",t=>this._roving.handleFocusIn(t)))}_select(e){const t=e.dataset.value??"";t!==this.value&&(this.value=t,this.emit("ev-segmented-button-change",{value:this.value}),this.update())}}I("ev-segmented-button",vi);class pi extends A{static props={heading:{type:"string",reflect:!0,default:""},description:{type:"string",reflect:!0,default:""},tone:{type:"string",reflect:!0,default:"neutral"}};static styles=R`
    :host {
      display: block;
      font-family: var(--ev-font-family);
      color: var(--ev-empty-state-color, var(--ev-color-text-primary));
    }

    .card {
      display: grid;
      gap: var(--ev-empty-state-gap, var(--ev-space-3));
      padding: var(--ev-empty-state-padding, var(--ev-space-4));
      border-radius: var(--ev-empty-state-radius, var(--ev-radius-lg));
      border: 1px solid var(--ev-empty-state-border, var(--ev-color-border));
      background: var(--ev-empty-state-bg, var(--ev-color-surface-raised));
    }

    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--ev-space-3);
    }

    .media {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--ev-empty-state-accent, var(--ev-color-text-tertiary));
    }

    .media--hidden,
    .actions--hidden {
      display: none;
    }

    .copy {
      display: grid;
      gap: var(--ev-space-2);
    }

    .heading {
      margin: 0;
      font-size: var(--ev-empty-state-heading-size, var(--ev-font-size-lg));
      font-weight: var(--ev-font-weight-semibold);
      line-height: var(--ev-line-height-tight);
    }

    .description {
      color: var(--ev-empty-state-description-color, var(--ev-color-text-secondary));
      line-height: var(--ev-line-height-relaxed);
    }

    .actions {
      display: inline-flex;
      align-items: center;
      gap: var(--ev-space-2);
      flex-wrap: wrap;
    }
  `;get renderMode(){return"stable"}render(){return _`
      <section class="card" data-ref="card">
        <div class="top">
          <div class="media media--hidden" data-ref="media">
            <slot name="media" data-ref="media-slot"></slot>
          </div>
          <div class="actions actions--hidden" data-ref="actions">
            <slot name="actions" data-ref="actions-slot"></slot>
          </div>
        </div>
        <div class="copy">
          <h3 class="heading" data-ref="heading"></h3>
          <p class="description" data-ref="description"></p>
        </div>
      </section>
    `}bindEvents(){this.listen(this.ref("media-slot"),"slotchange",()=>{this._syncSlots()}),this.listen(this.ref("actions-slot"),"slotchange",()=>{this._syncSlots()})}syncDom(){const e=Ee(this.tone,"neutral"),t=Te(e,"neutral"),r=this.ref("card"),i=this.ref("heading"),n=this.ref("description");r&&(r.className="card",r.setAttribute("style",ie({"--ev-empty-state-accent":t.accent,"--ev-empty-state-border":t.subtleBorder,"--ev-empty-state-bg":e==="neutral"?"var(--ev-color-surface-raised)":t.subtleBg}))),i&&(i.textContent=this.heading),n&&(n.textContent=this.description),this._syncSlots()}_syncSlots(){const e=this.ref("media"),t=this.ref("actions"),r=this.ref("media-slot"),i=this.ref("actions-slot"),n=(r?.assignedNodes({flatten:!0}).length??0)>0,a=(i?.assignedNodes({flatten:!0}).length??0)>0;e?.classList.toggle("media--hidden",!n),t?.classList.toggle("actions--hidden",!a)}}I("ev-empty-state",pi);class fi extends A{static props={shape:{type:"string",reflect:!0,default:"text"},width:{type:"string",reflect:!0,default:""},height:{type:"string",reflect:!0,default:""},size:{type:"string",reflect:!0,default:"md"},lines:{type:"number",reflect:!0,default:3}};static styles=R`
    :host {
      display: block;
      font-family: var(--ev-font-family);
    }

    .bone {
      background: var(--ev-skeleton-bg, var(--ev-color-border, #e0e0e0));
      border-radius: var(--ev-skeleton-radius, var(--ev-radius-sm));
      animation: pulse 1.5s var(--ev-ease-in-out, ease-in-out) infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    @media (prefers-reduced-motion: reduce) {
      .bone {
        animation: none;
        opacity: 0.6;
      }
    }

    /* text shape */
    .bone--text {
      height: 14px;
      width: 100%;
      margin-bottom: var(--ev-space-2);
    }

    .bone--text:last-child {
      width: 60%;
      margin-bottom: 0;
    }

    /* block shape */
    .bone--block {
      border-radius: var(--ev-radius-md);
    }

    /* avatar shape */
    .bone--avatar {
      border-radius: var(--ev-radius-full);
    }

    :host([size="xs"]) .bone--avatar { width: 24px; height: 24px; }
    :host([size="sm"]) .bone--avatar { width: 32px; height: 32px; }
    :host([size="md"]) .bone--avatar,
    :host(:not([size])) .bone--avatar { width: 40px; height: 40px; }
    :host([size="lg"]) .bone--avatar { width: 56px; height: 56px; }
    :host([size="xl"]) .bone--avatar { width: 72px; height: 72px; }

    /* code shape */
    .code-container {
      display: flex;
      flex-direction: column;
      gap: var(--ev-space-1-5, 6px);
    }

    .bone--code-line {
      height: 12px;
      border-radius: var(--ev-radius-sm);
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }
  `;onConnect(){this.hasAttribute("role")||this.setAttribute("role","status")}render(){return _`
      <div aria-hidden="true">${this._renderShape()}</div>
      <span class="visually-hidden">Loading</span>
    `}_renderShape(){switch(this.shape){case"block":return this._renderBlock();case"avatar":return this._renderAvatar();case"code":return this._renderCode();default:return this._renderText()}}_renderText(){const e=Math.max(1,this.lines),t=[];for(let r=0;r<e;r++)t.push(_`<div class="bone bone--text"></div>`);return _`${t}`}_renderBlock(){const e=this.width||"100%",t=this.height||"120px";return _`<div class="bone bone--block" style="width: ${e}; height: ${t};"></div>`}_renderAvatar(){return _`<div class="bone bone--avatar"></div>`}_renderCode(){const e=Math.max(1,this.lines),t=[90,75,85,60,95,70,80,55,88,65],r=[];for(let i=0;i<e;i++){const n=t[i%t.length];r.push(_`<div class="bone bone--code-line" style="width: ${n}%;"></div>`)}return _`<div class="code-container">${r}</div>`}}I("ev-skeleton",fi);class bi extends A{static props={variant:{type:"string",reflect:!0,default:"default"},tone:{type:"string",reflect:!0,default:""},removable:{type:"boolean",reflect:!0,default:!1},disabled:{type:"boolean",reflect:!0,default:!1},icon:{type:"string",reflect:!0,default:""},size:{type:"string",reflect:!0,default:"md"}};static styles=R`
    :host {
      display: inline-flex;
      vertical-align: middle;
      font-family: var(--ev-font-family);
    }

    :host([disabled]) {
      pointer-events: none;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: var(--ev-chip-gap, var(--ev-space-1));
      border-radius: var(--ev-chip-radius, var(--ev-radius-full));
      font-weight: var(--ev-font-weight-medium);
      line-height: 1;
      white-space: nowrap;
      cursor: default;
      user-select: none;
      border: 1px solid transparent;
      transition:
        background var(--ev-transition-fast),
        border-color var(--ev-transition-fast),
        box-shadow var(--ev-transition-fast);
      background: var(--_chip-bg, var(--ev-color-secondary-subtle));
      border-color: var(--_chip-border, var(--ev-color-border));
      color: var(--_chip-color, var(--ev-color-text-primary));
    }

    :host([size="sm"]) .chip {
      height: 22px;
      padding: 0 var(--ev-space-2);
      font-size: var(--ev-font-size-2xs);
    }

    :host([size="md"]) .chip,
    :host(:not([size])) .chip {
      height: 26px;
      padding: 0 var(--ev-space-3);
      font-size: var(--ev-font-size-xs);
    }

    .chip:hover {
      background: var(--_chip-bg-hover, var(--_chip-bg, var(--ev-color-secondary-subtle)));
    }

    :host([disabled]) .chip {
      opacity: var(--ev-state-disabled-opacity, 0.5);
      cursor: not-allowed;
    }

    .chip-icon {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
    }

    :host([size="sm"]) .chip-icon {
      font-size: var(--ev-font-size-2xs);
    }

    :host([size="md"]) .chip-icon,
    :host(:not([size])) .chip-icon {
      font-size: var(--ev-font-size-xs);
    }

    .chip-remove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: var(--ev-chip-remove-size, 16px);
      height: var(--ev-chip-remove-size, 16px);
      margin-inline-start: var(--ev-space-0-5);
      margin-inline-end: calc(-1 * var(--ev-space-1));
      padding: 0;
      border: none;
      border-radius: var(--ev-radius-full);
      background: transparent;
      color: inherit;
      opacity: 0.6;
      cursor: pointer;
      transition: opacity var(--ev-transition-fast), background var(--ev-transition-fast);
      font-size: var(--ev-font-size-2xs);
      line-height: 1;
    }

    .chip-remove:hover {
      opacity: 1;
      background: var(--ev-state-hover-bg);
    }

    .chip-remove:active {
      opacity: 1;
      background: var(--ev-state-active-bg);
    }

    :host([disabled]) .chip-remove {
      pointer-events: none;
    }
  `;getResolvedStyle(){const e=Te(this.tone||this.variant,"neutral");return ie({"--_chip-bg":e.subtleBg,"--_chip-border":e.subtleBorder,"--_chip-bg-hover":e.subtleHover,"--_chip-color":e.subtleColor})}render(){const e=this.icon?_`<span class="chip-icon"><ev-icon name="${this.icon}" size="sm"></ev-icon></span>`:"",t=this.removable?_`<button class="chip-remove" aria-label="Remove" type="button">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>`:"";return _`
      <span class="chip" style="${this.getResolvedStyle()}">
        ${e}
        <span class="chip-content"><slot></slot></span>
        ${t}
      </span>
    `}bindEvents(){if(this.removable&&!this.disabled){const e=this.query(".chip-remove");e&&e.addEventListener("click",this._onRemove)}}_onRemove=e=>{e.stopPropagation(),this.emit("ev-chip-remove")}}I("ev-chip",bi);Tr({autoDetectPlatform:!1});const Ne={route:"osca-portal:route",sidebar:"osca-portal:sidebar"};function mr(s,e){try{const t=localStorage.getItem(s);return t===null?e:JSON.parse(t)}catch{return e}}function gr(s,e){try{localStorage.setItem(s,JSON.stringify(e))}catch{}}const nt=s=>`${s.mod.key}/${s.item.key}`;function pt(s){const[e,t]=(s??"").split("/"),r=Ae.find(n=>n.key===e)??Ae[0],i=r.nav.find(n=>n.key===t)??r.nav[0];return{mod:r,item:i}}const yr=()=>location.hash.startsWith("#/")?location.hash.slice(2):null;let _r=pt(yr()??mr(Ne.route,null));function Be(s){location.hash!==`#/${s}`?location.hash=`/${s}`:bt(pt(s))}const ft=document.querySelector("#app");if(!ft)throw new Error("#app missing");await ni(ft);G.onExpired(()=>location.reload());window.addEventListener("hashchange",()=>bt(pt(yr())));const wr="248px";ft.innerHTML=`
  <ev-shell sidebar-left-width="${mr(Ne.sidebar,!0)?wr:"0px"}" sidebar-left-min="200" sidebar-left-max="420"
            sidebar-right-width="0px" sidebar-right-resizable="false">
    <header slot="header" class="toolbar">
      <ev-icon-button id="btn-sidebar" icon="panel-left" label="Toggle menu"></ev-icon-button>
      <div class="brand"><span class="mark">OS</span>OSCA Portal</div>
      <div class="toolbar-center">
        <button type="button" class="jump" id="btn-jump">
          <ev-icon name="search" size="xs"></ev-icon><span>Search or jump to…</span><kbd>Ctrl K</kbd>
        </button>
      </div>
      <div id="pulse" class="pulse"></div>
      <div class="instance" id="instance" title="Connected instance">…</div>
      <ev-icon-button id="btn-theme" icon="moon" label="Toggle light / dark"></ev-icon-button>
      <div class="user-menu-wrap">
        <ev-icon-button id="btn-user" icon="user" label="Account"></ev-icon-button>
        <div class="user-menu" id="user-menu" role="menu" hidden>
          <div class="user-menu-who"><span class="dim">${G.anonymous?"Not signed in":"Signed in as"}</span><b id="user-name">${G.anonymous?"":x(G.user)}</b></div>
          <button type="button" role="menuitem" id="btn-signout">${G.anonymous?"Sign in":"Sign out"}</button>
        </div>
      </div>
    </header>
    <aside slot="sidebar-left" class="navhost">
      <div id="nav-mount" class="nav-mount"></div>
    </aside>
    <main slot="main" class="portal-main" id="main"></main>
  </ev-shell>
  <ev-command-palette></ev-command-palette>
`;const Kt=document.querySelector("ev-shell"),U=document.querySelector("#main"),mi=document.querySelector("#nav-mount");let Ue=[];function bt(s){for(const a of Ue)try{a()}catch{}Ue=[],_r=s,gr(Ne.route,nt(s));const e=s.mod.key==="home",t=e?"Overview":s.item.label,r=s.item.description??"";U.classList.remove("portal-main--fill"),U.innerHTML=`
    <header class="page-head">
      ${e?"":`<div class="crumbs">${s.mod.label}</div>`}
      <div class="page-title-row">
        <h1 id="page-title">${t}</h1>
        <div class="page-actions" id="page-actions"></div>
      </div>
      <p class="page-subtitle" id="page-subtitle"${r?"":" hidden"}>${r}</p>
    </header>
    <div class="page-body" id="view-body"></div>`,document.title=`${t} · OSCA Portal`;const i=U.querySelector("#view-body"),n=U.querySelector("#page-actions");s.item.screen?s.item.screen({body:i,actions:n,navigate:Be,onLeave:a=>Ue.push(a),heading:(a,o)=>{U.querySelector("#page-title").innerHTML=a;const c=U.querySelector("#page-subtitle");o!==void 0&&(c.innerHTML=o,c.hidden=!o)},fill:()=>U.classList.add("portal-main--fill")}):s.item.render?.(i),U.scrollTop=0,yi.sync(s)}function gi(s){const e=document.createElement("div");e.className="menu-accordion";const t=document.createElement("ev-accordion");t.setAttribute("fill","");const r=new Map,i=new Map,n=(a,o,c,l)=>{const d=document.createElement("button");return d.type="button",d.className=c,d.innerHTML=`<span>${o}</span>`,d.addEventListener("click",()=>Be(a)),r.set(a,d),d};for(const a of Ae){if(a.nav.length===1){t.appendChild(n(`${a.key}/${a.nav[0].key}`,a.label,"acc-single"));continue}const o=document.createElement("ev-accordion-item");o.setAttribute("heading",a.label);const c=document.createElement("div");c.className="acc-items";for(const l of a.nav)c.appendChild(n(`${a.key}/${l.key}`,l.label,"acc-item"));o.appendChild(c),i.set(a.key,o),t.appendChild(o)}return e.appendChild(t),s.appendChild(e),{sync(a){for(const[c,l]of r)l.classList.toggle("active",c===nt(a));const o=i.get(a.mod.key);if(o&&!o.expanded&&(o.expanded=!0),!o)for(const c of i.values())c.expanded&&(c.expanded=!1);r.get(nt(a))?.scrollIntoView({block:"nearest"})}}}const yi=gi(mi);bt(_r);document.querySelector("#btn-sidebar")?.addEventListener("click",()=>{const s=Kt.sidebarLeftWidth==="0px";Kt.sidebarLeftWidth=s?wr:"0px",gr(Ne.sidebar,s)});const mt=document.querySelector("#btn-theme"),xr=()=>mt.setAttribute("icon",Le().mode==="dark"?"sun":"moon");mt.addEventListener("click",()=>{Lr({mode:Le().mode==="dark"?"light":"dark"}),xr()});xr();const _i=document.querySelector("ev-command-palette");document.querySelector("#btn-jump")?.addEventListener("click",()=>_i.open());for(const s of Ae)for(const e of s.nav)j.register({id:`nav:${s.key}:${e.key}`,label:s.nav.length===1?s.label:`${s.label}: ${e.label}`,group:"Go to",icon:s.icon,run:()=>Be(`${s.key}/${e.key}`)});j.register({id:"view:theme",label:"Toggle light / dark",group:"View",run:()=>mt.click()});j.register({id:"view:menu",label:"Toggle menu",group:"View",run:()=>document.querySelector("#btn-sidebar").click()});let at="",ot="";const kr=()=>{document.querySelector("#instance").innerHTML=`<b>${x(at||"IRIS")}</b>${ot?`<span class="pill">${x(ot)}</span>`:""}`};ys().then(s=>{const e=/(\d{4}\.\d+)[^)]*\(Build ([^)]+)\)/.exec(s.serverVersion);e&&(ot=`${e[1]} · ${e[2]}`),kr()}).catch(()=>{document.querySelector("#instance").textContent="Not connected"});N.subscribe(s=>{const e=s.get("iris_system_info")?.[0]?.labels.id??"";e&&e!==at&&(at=e,kr())});{const s=document.querySelector("#user-menu"),e=document.querySelector("#btn-user"),t=()=>{s.hidden=!0};e.addEventListener("click",r=>{r.stopPropagation(),s.hidden=!s.hidden}),document.addEventListener("click",r=>{s.contains(r.target)||t()}),document.addEventListener("keydown",r=>{r.key==="Escape"&&t()}),document.querySelector("#btn-signout")?.addEventListener("click",()=>{Et().then(()=>location.reload())}),j.register({id:"account:signout",label:G.anonymous?"Sign in":"Sign out",group:"Account",run:()=>void Et().then(()=>location.reload())})}{const s=document.querySelector("#pulse");let e=null,t=0;const r=i=>{e=i;const n=Qe(C(i,"iris_system_state")),a=C(i,"iris_cpu_usage"),o=C(i,"iris_process_count"),c=C(i,"iris_system_alerts"),l=a>=90?"danger":a>=70?"warning":"neutral";s.innerHTML=`
      <button type="button" class="pulse-seg" data-tone="${n.tone}" data-go="home/overview" title="Overall health, as IRIS reports it"><span class="dot"></span>${n.label}</button>
      <button type="button" class="pulse-seg" data-tone="${l}" data-go="operations/overview" title="CPU use across the whole machine, not just IRIS">System CPU <b>${Number.isFinite(a)?Math.round(a):"—"}%</b></button>
      <button type="button" class="pulse-seg" data-tone="neutral" data-go="operations/processes" title="Active processes"><b>${Number.isFinite(o)?o:"—"}</b> processes</button>
      <button type="button" class="pulse-seg" data-tone="${t>0?"warning":"neutral"}" data-go="logs/alerts"
        title="${t>0?`${t} alert${t===1?"":"s"} in the last 24 hours`:"Alerts raised since IRIS started"}"><b>${t>0?t:Number.isFinite(c)?c:"—"}</b> alert${(t||c)===1?"":"s"}</button>`,s.querySelectorAll("[data-go]").forEach(d=>d.addEventListener("click",()=>Be(d.dataset.go??"")))};N.subscribe(i=>r(i),()=>{s.innerHTML='<span class="pulse-seg" data-tone="danger"><span class="dot"></span>Not connected</span>'}),ne.subscribe(i=>{const n=Date.now()-864e5;t=i.filter(a=>Date.parse(a.time)>=n).length,e&&r(e)})}
