const Ur = (e, t) => e === t, we = Symbol("solid-proxy"), dt = Symbol("solid-track"), Ue = {
  equals: Ur
};
let er = ar;
const me = 1, Ke = 2, tr = {
  owned: null,
  cleanups: null,
  context: null,
  owner: null
};
var V = null;
let ct = null, Kr = null, G = null, te = null, he = null, rt = 0;
function Be(e, t) {
  const r = G, n = V, o = e.length === 0, s = t === void 0 ? n : t, a = o ? tr : {
    owned: null,
    cleanups: null,
    context: s ? s.context : null,
    owner: s
  }, i = o ? e : () => e(() => oe(() => Te(a)));
  V = a, G = null;
  try {
    return ke(i, !0);
  } finally {
    G = r, V = n;
  }
}
function L(e, t) {
  t = t ? Object.assign({}, Ue, t) : Ue;
  const r = {
    value: e,
    observers: null,
    observerSlots: null,
    comparator: t.equals || void 0
  }, n = (o) => (typeof o == "function" && (o = o(r.value)), ir(r, o));
  return [or.bind(r), n];
}
function T(e, t, r) {
  const n = $t(e, t, !1, me);
  Ne(n);
}
function $e(e, t, r) {
  er = Zr;
  const n = $t(e, t, !1, me);
  n.user = !0, he ? he.push(n) : Ne(n);
}
function Q(e, t, r) {
  r = r ? Object.assign({}, Ue, r) : Ue;
  const n = $t(e, t, !0, 0);
  return n.observers = null, n.observerSlots = null, n.comparator = r.equals || void 0, Ne(n), or.bind(n);
}
function Gr(e) {
  return ke(e, !1);
}
function oe(e) {
  if (G === null) return e();
  const t = G;
  G = null;
  try {
    return e();
  } finally {
    G = t;
  }
}
function Pt(e, t, r) {
  const n = Array.isArray(e);
  let o;
  return (s) => {
    let a;
    if (n) {
      a = Array(e.length);
      for (let l = 0; l < e.length; l++) a[l] = e[l]();
    } else a = e();
    const i = oe(() => t(a, o, s));
    return o = a, i;
  };
}
function rr(e) {
  $e(() => oe(e));
}
function De(e) {
  return V === null || (V.cleanups === null ? V.cleanups = [e] : V.cleanups.push(e)), e;
}
function ft() {
  return G;
}
function nr(e, t) {
  const r = Symbol("context");
  return {
    id: r,
    Provider: Yr(r),
    defaultValue: e
  };
}
function sr(e) {
  const t = Q(e), r = Q(() => ht(t()));
  return r.toArray = () => {
    const n = r();
    return Array.isArray(n) ? n : n != null ? [n] : [];
  }, r;
}
function or() {
  if (this.sources && this.state)
    if (this.state === me) Ne(this);
    else {
      const e = te;
      te = null, ke(() => Ve(this), !1), te = e;
    }
  if (G) {
    const e = this.observers ? this.observers.length : 0;
    G.sources ? (G.sources.push(this), G.sourceSlots.push(e)) : (G.sources = [this], G.sourceSlots = [e]), this.observers ? (this.observers.push(G), this.observerSlots.push(G.sources.length - 1)) : (this.observers = [G], this.observerSlots = [G.sources.length - 1]);
  }
  return this.value;
}
function ir(e, t, r) {
  let n = e.value;
  return (!e.comparator || !e.comparator(n, t)) && (e.value = t, e.observers && e.observers.length && ke(() => {
    for (let o = 0; o < e.observers.length; o += 1) {
      const s = e.observers[o], a = ct && ct.running;
      a && ct.disposed.has(s), (a ? !s.tState : !s.state) && (s.pure ? te.push(s) : he.push(s), s.observers && lr(s)), a || (s.state = me);
    }
    if (te.length > 1e6)
      throw te = [], new Error();
  }, !1)), t;
}
function Ne(e) {
  if (!e.fn) return;
  Te(e);
  const t = rt;
  Vr(e, e.value, t);
}
function Vr(e, t, r) {
  let n;
  const o = V, s = G;
  G = V = e;
  try {
    n = e.fn(t);
  } catch (a) {
    return e.pure && (e.state = me, e.owned && e.owned.forEach(Te), e.owned = null), e.updatedAt = r + 1, cr(a);
  } finally {
    G = s, V = o;
  }
  (!e.updatedAt || e.updatedAt <= r) && (e.updatedAt != null && "observers" in e ? ir(e, n) : e.value = n, e.updatedAt = r);
}
function $t(e, t, r, n = me, o) {
  const s = {
    fn: e,
    state: n,
    updatedAt: null,
    owned: null,
    sources: null,
    sourceSlots: null,
    cleanups: null,
    value: t,
    owner: V,
    context: V ? V.context : null,
    pure: r
  };
  return V === null || V !== tr && (V.owned ? V.owned.push(s) : V.owned = [s]), s;
}
function Ge(e) {
  if (e.state === 0) return;
  if (e.state === Ke) return Ve(e);
  if (e.suspense && oe(e.suspense.inFallback)) return e.suspense.effects.push(e);
  const t = [e];
  for (; (e = e.owner) && (!e.updatedAt || e.updatedAt < rt); )
    e.state && t.push(e);
  for (let r = t.length - 1; r >= 0; r--)
    if (e = t[r], e.state === me)
      Ne(e);
    else if (e.state === Ke) {
      const n = te;
      te = null, ke(() => Ve(e, t[0]), !1), te = n;
    }
}
function ke(e, t) {
  if (te) return e();
  let r = !1;
  t || (te = []), he ? r = !0 : he = [], rt++;
  try {
    const n = e();
    return Jr(r), n;
  } catch (n) {
    r || (he = null), te = null, cr(n);
  }
}
function Jr(e) {
  if (te && (ar(te), te = null), e) return;
  const t = he;
  he = null, t.length && ke(() => er(t), !1);
}
function ar(e) {
  for (let t = 0; t < e.length; t++) Ge(e[t]);
}
function Zr(e) {
  let t, r = 0;
  for (t = 0; t < e.length; t++) {
    const n = e[t];
    n.user ? e[r++] = n : Ge(n);
  }
  for (t = 0; t < r; t++) Ge(e[t]);
}
function Ve(e, t) {
  e.state = 0;
  for (let r = 0; r < e.sources.length; r += 1) {
    const n = e.sources[r];
    if (n.sources) {
      const o = n.state;
      o === me ? n !== t && (!n.updatedAt || n.updatedAt < rt) && Ge(n) : o === Ke && Ve(n, t);
    }
  }
}
function lr(e) {
  for (let t = 0; t < e.observers.length; t += 1) {
    const r = e.observers[t];
    r.state || (r.state = Ke, r.pure ? te.push(r) : he.push(r), r.observers && lr(r));
  }
}
function Te(e) {
  let t;
  if (e.sources)
    for (; e.sources.length; ) {
      const r = e.sources.pop(), n = e.sourceSlots.pop(), o = r.observers;
      if (o && o.length) {
        const s = o.pop(), a = r.observerSlots.pop();
        n < o.length && (s.sourceSlots[a] = n, o[n] = s, r.observerSlots[n] = a);
      }
    }
  if (e.tOwned) {
    for (t = e.tOwned.length - 1; t >= 0; t--) Te(e.tOwned[t]);
    delete e.tOwned;
  }
  if (e.owned) {
    for (t = e.owned.length - 1; t >= 0; t--) Te(e.owned[t]);
    e.owned = null;
  }
  if (e.cleanups) {
    for (t = e.cleanups.length - 1; t >= 0; t--) e.cleanups[t]();
    e.cleanups = null;
  }
  e.state = 0;
}
function Xr(e) {
  return e instanceof Error ? e : new Error(typeof e == "string" ? e : "Unknown error", {
    cause: e
  });
}
function cr(e, t = V) {
  throw Xr(e);
}
function ht(e) {
  if (typeof e == "function" && !e.length) return ht(e());
  if (Array.isArray(e)) {
    const t = [];
    for (let r = 0; r < e.length; r++) {
      const n = ht(e[r]);
      Array.isArray(n) ? t.push.apply(t, n) : t.push(n);
    }
    return t;
  }
  return e;
}
function Yr(e, t) {
  return function(n) {
    let o;
    return T(() => o = oe(() => (V.context = {
      ...V.context,
      [e]: n.value
    }, sr(() => n.children))), void 0), o;
  };
}
const en = Symbol("fallback");
function Tt(e) {
  for (let t = 0; t < e.length; t++) e[t]();
}
function tn(e, t, r = {}) {
  let n = [], o = [], s = [], a = 0, i = t.length > 1 ? [] : null;
  return De(() => Tt(s)), () => {
    let l = e() || [], c = l.length, d, u;
    return l[dt], oe(() => {
      let g, m, p, b, _, y, I, x, R;
      if (c === 0)
        a !== 0 && (Tt(s), s = [], n = [], o = [], a = 0, i && (i = [])), r.fallback && (n = [en], o[0] = Be((F) => (s[0] = F, r.fallback())), a = 1);
      else if (a === 0) {
        for (o = new Array(c), u = 0; u < c; u++)
          n[u] = l[u], o[u] = Be(h);
        a = c;
      } else {
        for (p = new Array(c), b = new Array(c), i && (_ = new Array(c)), y = 0, I = Math.min(a, c); y < I && n[y] === l[y]; y++) ;
        for (I = a - 1, x = c - 1; I >= y && x >= y && n[I] === l[x]; I--, x--)
          p[x] = o[I], b[x] = s[I], i && (_[x] = i[I]);
        for (g = /* @__PURE__ */ new Map(), m = new Array(x + 1), u = x; u >= y; u--)
          R = l[u], d = g.get(R), m[u] = d === void 0 ? -1 : d, g.set(R, u);
        for (d = y; d <= I; d++)
          R = n[d], u = g.get(R), u !== void 0 && u !== -1 ? (p[u] = o[d], b[u] = s[d], i && (_[u] = i[d]), u = m[u], g.set(R, u)) : s[d]();
        for (u = y; u < c; u++)
          u in p ? (o[u] = p[u], s[u] = b[u], i && (i[u] = _[u], i[u](u))) : o[u] = Be(h);
        o = o.slice(0, a = c), n = l.slice(0);
      }
      return o;
    });
    function h(g) {
      if (s[u] = g, i) {
        const [m, p] = L(u);
        return i[u] = p, t(l[u], m);
      }
      return t(l[u]);
    }
  };
}
function w(e, t) {
  return oe(() => e(t || {}));
}
const ur = (e) => `Stale read from <${e}>.`;
function J(e) {
  const t = "fallback" in e && {
    fallback: () => e.fallback
  };
  return Q(tn(() => e.each, e.children, t || void 0));
}
function q(e) {
  const t = e.keyed, r = Q(() => e.when, void 0, void 0), n = t ? r : Q(r, void 0, {
    equals: (o, s) => !o == !s
  });
  return Q(() => {
    const o = n();
    if (o) {
      const s = e.children;
      return typeof s == "function" && s.length > 0 ? oe(() => s(t ? o : () => {
        if (!oe(n)) throw ur("Show");
        return r();
      })) : s;
    }
    return e.fallback;
  }, void 0, void 0);
}
function rn(e) {
  const t = sr(() => e.children), r = Q(() => {
    const n = t(), o = Array.isArray(n) ? n : [n];
    let s = () => {
    };
    for (let a = 0; a < o.length; a++) {
      const i = a, l = o[a], c = s, d = Q(() => c() ? void 0 : l.when, void 0, void 0), u = l.keyed ? d : Q(d, void 0, {
        equals: (h, g) => !h == !g
      });
      s = () => c() || (u() ? [i, d, l] : void 0);
    }
    return s;
  });
  return Q(() => {
    const n = r()();
    if (!n) return e.fallback;
    const [o, s, a] = n, i = a.children;
    return typeof i == "function" && i.length > 0 ? oe(() => i(a.keyed ? s() : () => {
      if (oe(r)()?.[0] !== o) throw ur("Match");
      return s();
    })) : i;
  }, void 0, void 0);
}
function Ce(e) {
  return e;
}
const Le = (e) => Q(() => e());
function nn(e, t, r) {
  let n = r.length, o = t.length, s = n, a = 0, i = 0, l = t[o - 1].nextSibling, c = null;
  for (; a < o || i < s; ) {
    if (t[a] === r[i]) {
      a++, i++;
      continue;
    }
    for (; t[o - 1] === r[s - 1]; )
      o--, s--;
    if (o === a) {
      const d = s < n ? i ? r[i - 1].nextSibling : r[s - i] : l;
      for (; i < s; ) e.insertBefore(r[i++], d);
    } else if (s === i)
      for (; a < o; )
        (!c || !c.has(t[a])) && t[a].remove(), a++;
    else if (t[a] === r[s - 1] && r[i] === t[o - 1]) {
      const d = t[--o].nextSibling;
      e.insertBefore(r[i++], t[a++].nextSibling), e.insertBefore(r[--s], d), t[o] = r[s];
    } else {
      if (!c) {
        c = /* @__PURE__ */ new Map();
        let u = i;
        for (; u < s; ) c.set(r[u], u++);
      }
      const d = c.get(t[a]);
      if (d != null)
        if (i < d && d < s) {
          let u = a, h = 1, g;
          for (; ++u < o && u < s && !((g = c.get(t[u])) == null || g !== d + h); )
            h++;
          if (h > d - i) {
            const m = t[a];
            for (; i < d; ) e.insertBefore(r[i++], m);
          } else e.replaceChild(r[i++], t[a++]);
        } else a++;
      else t[a++].remove();
    }
  }
}
const Et = "_$DX_DELEGATE";
function sn(e, t, r, n = {}) {
  let o;
  return Be((s) => {
    o = s, t === document ? e() : f(t, e(), t.firstChild ? null : void 0, r);
  }, n.owner), () => {
    o(), t.textContent = "";
  };
}
function S(e, t, r, n) {
  let o;
  const s = () => {
    const i = n ? document.createElementNS("http://www.w3.org/1998/Math/MathML", "template") : document.createElement("template");
    return i.innerHTML = e, r ? i.content.firstChild.firstChild : n ? i.firstChild : i.content.firstChild;
  }, a = t ? () => oe(() => document.importNode(o || (o = s()), !0)) : () => (o || (o = s())).cloneNode(!0);
  return a.cloneNode = a, a;
}
function pe(e, t = window.document) {
  const r = t[Et] || (t[Et] = /* @__PURE__ */ new Set());
  for (let n = 0, o = e.length; n < o; n++) {
    const s = e[n];
    r.has(s) || (r.add(s), t.addEventListener(s, an));
  }
}
function K(e, t, r) {
  r == null ? e.removeAttribute(t) : e.setAttribute(t, r);
}
function ie(e, t) {
  t == null ? e.removeAttribute("class") : e.className = t;
}
function on(e, t, r = {}) {
  const n = Object.keys(t || {}), o = Object.keys(r);
  let s, a;
  for (s = 0, a = o.length; s < a; s++) {
    const i = o[s];
    !i || i === "undefined" || t[i] || (qt(e, i, !1), delete r[i]);
  }
  for (s = 0, a = n.length; s < a; s++) {
    const i = n[s], l = !!t[i];
    !i || i === "undefined" || r[i] === l || !l || (qt(e, i, !0), r[i] = l);
  }
  return r;
}
function Pe(e, t, r) {
  r != null ? e.style.setProperty(t, r) : e.style.removeProperty(t);
}
function Mt(e, t, r) {
  return oe(() => e(t, r));
}
function f(e, t, r, n) {
  if (r !== void 0 && !n && (n = []), typeof t != "function") return Je(e, t, n, r);
  T((o) => Je(e, t(), o, r), n);
}
function qt(e, t, r) {
  const n = t.trim().split(/\s+/);
  for (let o = 0, s = n.length; o < s; o++) e.classList.toggle(n[o], r);
}
function an(e) {
  let t = e.target;
  const r = `$$${e.type}`, n = e.target, o = e.currentTarget, s = (l) => Object.defineProperty(e, "target", {
    configurable: !0,
    value: l
  }), a = () => {
    const l = t[r];
    if (l && !t.disabled) {
      const c = t[`${r}Data`];
      if (c !== void 0 ? l.call(t, c, e) : l.call(t, e), e.cancelBubble) return;
    }
    return t.host && typeof t.host != "string" && !t.host._$host && t.contains(e.target) && s(t.host), !0;
  }, i = () => {
    for (; a() && (t = t._$host || t.parentNode || t.host); ) ;
  };
  if (Object.defineProperty(e, "currentTarget", {
    configurable: !0,
    get() {
      return t || document;
    }
  }), e.composedPath) {
    const l = e.composedPath();
    s(l[0]);
    for (let c = 0; c < l.length - 2 && (t = l[c], !!a()); c++) {
      if (t._$host) {
        t = t._$host, i();
        break;
      }
      if (t.parentNode === o)
        break;
    }
  } else i();
  s(n);
}
function Je(e, t, r, n, o) {
  for (; typeof r == "function"; ) r = r();
  if (t === r) return r;
  const s = typeof t, a = n !== void 0;
  if (e = a && r[0] && r[0].parentNode || e, s === "string" || s === "number") {
    if (s === "number" && (t = t.toString(), t === r))
      return r;
    if (a) {
      let i = r[0];
      i && i.nodeType === 3 ? i.data !== t && (i.data = t) : i = document.createTextNode(t), r = ve(e, r, n, i);
    } else
      r !== "" && typeof r == "string" ? r = e.firstChild.data = t : r = e.textContent = t;
  } else if (t == null || s === "boolean")
    r = ve(e, r, n);
  else {
    if (s === "function")
      return T(() => {
        let i = t();
        for (; typeof i == "function"; ) i = i();
        r = Je(e, i, r, n);
      }), () => r;
    if (Array.isArray(t)) {
      const i = [], l = r && Array.isArray(r);
      if (pt(i, t, r, o))
        return T(() => r = Je(e, i, r, n, !0)), () => r;
      if (i.length === 0) {
        if (r = ve(e, r, n), a) return r;
      } else l ? r.length === 0 ? Ft(e, i, n) : nn(e, r, i) : (r && ve(e), Ft(e, i));
      r = i;
    } else if (t.nodeType) {
      if (Array.isArray(r)) {
        if (a) return r = ve(e, r, n, t);
        ve(e, r, null, t);
      } else r == null || r === "" || !e.firstChild ? e.appendChild(t) : e.replaceChild(t, e.firstChild);
      r = t;
    }
  }
  return r;
}
function pt(e, t, r, n) {
  let o = !1;
  for (let s = 0, a = t.length; s < a; s++) {
    let i = t[s], l = r && r[e.length], c;
    if (!(i == null || i === !0 || i === !1)) if ((c = typeof i) == "object" && i.nodeType)
      e.push(i);
    else if (Array.isArray(i))
      o = pt(e, i, l) || o;
    else if (c === "function")
      if (n) {
        for (; typeof i == "function"; ) i = i();
        o = pt(e, Array.isArray(i) ? i : [i], Array.isArray(l) ? l : [l]) || o;
      } else
        e.push(i), o = !0;
    else {
      const d = String(i);
      l && l.nodeType === 3 && l.data === d ? e.push(l) : e.push(document.createTextNode(d));
    }
  }
  return o;
}
function Ft(e, t, r = null) {
  for (let n = 0, o = t.length; n < o; n++) e.insertBefore(t[n], r);
}
function ve(e, t, r, n) {
  if (r === void 0) return e.textContent = "";
  const o = n || document.createTextNode("");
  if (t.length) {
    let s = !1;
    for (let a = t.length - 1; a >= 0; a--) {
      const i = t[a];
      if (o !== i) {
        const l = i.parentNode === e;
        !s && !a ? l ? e.replaceChild(o, i) : e.insertBefore(o, r) : l && i.remove();
      } else s = !0;
    }
  } else e.insertBefore(o, r);
  return [o];
}
const gt = Symbol("store-raw"), xe = Symbol("store-node"), fe = Symbol("store-has"), dr = Symbol("store-self");
function fr(e) {
  let t = e[we];
  if (!t && (Object.defineProperty(e, we, {
    value: t = new Proxy(e, un)
  }), !Array.isArray(e))) {
    const r = Object.keys(e), n = Object.getOwnPropertyDescriptors(e);
    for (let o = 0, s = r.length; o < s; o++) {
      const a = r[o];
      n[a].get && Object.defineProperty(e, a, {
        enumerable: n[a].enumerable,
        get: n[a].get.bind(t)
      });
    }
  }
  return t;
}
function Ze(e) {
  let t;
  return e != null && typeof e == "object" && (e[we] || !(t = Object.getPrototypeOf(e)) || t === Object.prototype || Array.isArray(e));
}
function Ee(e, t = /* @__PURE__ */ new Set()) {
  let r, n, o, s;
  if (r = e != null && e[gt]) return r;
  if (!Ze(e) || t.has(e)) return e;
  if (Array.isArray(e)) {
    Object.isFrozen(e) ? e = e.slice(0) : t.add(e);
    for (let a = 0, i = e.length; a < i; a++)
      o = e[a], (n = Ee(o, t)) !== o && (e[a] = n);
  } else {
    Object.isFrozen(e) ? e = Object.assign({}, e) : t.add(e);
    const a = Object.keys(e), i = Object.getOwnPropertyDescriptors(e);
    for (let l = 0, c = a.length; l < c; l++)
      s = a[l], !i[s].get && (o = e[s], (n = Ee(o, t)) !== o && (e[s] = n));
  }
  return e;
}
function Xe(e, t) {
  let r = e[t];
  return r || Object.defineProperty(e, t, {
    value: r = /* @__PURE__ */ Object.create(null)
  }), r;
}
function Me(e, t, r) {
  if (e[t]) return e[t];
  const [n, o] = L(r, {
    equals: !1,
    internal: !0
  });
  return n.$ = o, e[t] = n;
}
function ln(e, t) {
  const r = Reflect.getOwnPropertyDescriptor(e, t);
  return !r || r.get || !r.configurable || t === we || t === xe || (delete r.value, delete r.writable, r.get = () => e[we][t]), r;
}
function hr(e) {
  ft() && Me(Xe(e, xe), dr)();
}
function cn(e) {
  return hr(e), Reflect.ownKeys(e);
}
const un = {
  get(e, t, r) {
    if (t === gt) return e;
    if (t === we) return r;
    if (t === dt)
      return hr(e), r;
    const n = Xe(e, xe), o = n[t];
    let s = o ? o() : e[t];
    if (t === xe || t === fe || t === "__proto__") return s;
    if (!o) {
      const a = Object.getOwnPropertyDescriptor(e, t);
      ft() && (typeof s != "function" || e.hasOwnProperty(t)) && !(a && a.get) && (s = Me(n, t, s)());
    }
    return Ze(s) ? fr(s) : s;
  },
  has(e, t) {
    return t === gt || t === we || t === dt || t === xe || t === fe || t === "__proto__" ? !0 : (ft() && Me(Xe(e, fe), t)(), t in e);
  },
  set() {
    return !0;
  },
  deleteProperty() {
    return !0;
  },
  ownKeys: cn,
  getOwnPropertyDescriptor: ln
};
function Ye(e, t, r, n = !1) {
  if (!n && e[t] === r) return;
  const o = e[t], s = e.length;
  r === void 0 ? (delete e[t], e[fe] && e[fe][t] && o !== void 0 && e[fe][t].$()) : (e[t] = r, e[fe] && e[fe][t] && o === void 0 && e[fe][t].$());
  let a = Xe(e, xe), i;
  if ((i = Me(a, t, o)) && i.$(() => r), Array.isArray(e) && e.length !== s) {
    for (let l = e.length; l < s; l++) (i = a[l]) && i.$();
    (i = Me(a, "length", s)) && i.$(e.length);
  }
  (i = a[dr]) && i.$();
}
function pr(e, t) {
  const r = Object.keys(t);
  for (let n = 0; n < r.length; n += 1) {
    const o = r[n];
    Ye(e, o, t[o]);
  }
}
function dn(e, t) {
  if (typeof t == "function" && (t = t(e)), t = Ee(t), Array.isArray(t)) {
    if (e === t) return;
    let r = 0, n = t.length;
    for (; r < n; r++) {
      const o = t[r];
      e[r] !== o && Ye(e, r, o);
    }
    Ye(e, "length", n);
  } else pr(e, t);
}
function Re(e, t, r = []) {
  let n, o = e;
  if (t.length > 1) {
    n = t.shift();
    const a = typeof n, i = Array.isArray(e);
    if (Array.isArray(n)) {
      for (let l = 0; l < n.length; l++)
        Re(e, [n[l]].concat(t), r);
      return;
    } else if (i && a === "function") {
      for (let l = 0; l < e.length; l++)
        n(e[l], l) && Re(e, [l].concat(t), r);
      return;
    } else if (i && a === "object") {
      const {
        from: l = 0,
        to: c = e.length - 1,
        by: d = 1
      } = n;
      for (let u = l; u <= c; u += d)
        Re(e, [u].concat(t), r);
      return;
    } else if (t.length > 1) {
      Re(e[n], t, [n].concat(r));
      return;
    }
    o = e[n], r = [n].concat(r);
  }
  let s = t[0];
  typeof s == "function" && (s = s(o, r), s === o) || n === void 0 && s == null || (s = Ee(s), n === void 0 || Ze(o) && Ze(s) && !Array.isArray(s) ? pr(o, s) : Ye(e, n, s));
}
function fn(...[e, t]) {
  const r = Ee(e || {}), n = Array.isArray(r), o = fr(r);
  function s(...a) {
    Gr(() => {
      n && a.length === 1 ? dn(r, a[0]) : Re(r, a);
    });
  }
  return [o, s];
}
const hn = {
  currentView: "chat",
  agent: null,
  sessionId: null,
  sessions: [],
  workspaceRoot: null,
  settings: null,
  secretStatus: { openai: !1, anthropic: !1 },
  workflows: [],
  runs: [],
  selectedRunId: null,
  contextRunId: null,
  runDetails: {},
  runEvents: {},
  runEventSeq: {},
  frames: {},
  outputs: {},
  attempts: {},
  toolCalls: {},
  activeTab: "graph",
  inspectorOpen: !1,
  inspectorExpanded: !1,
  logQuery: "",
  logFilters: /* @__PURE__ */ new Set(["run", "node", "approval", "revert"]),
  graphZoom: 1,
  graphPan: { x: 0, y: 0 },
  toasts: []
}, [$, E] = fn(hn);
let pn = 0;
function se(e, t) {
  const r = `toast-${++pn}`;
  E("toasts", (n) => [...n, { id: r, level: e, message: t }]), setTimeout(() => {
    E("toasts", (n) => n.filter((o) => o.id !== r));
  }, 3500);
}
function je(e) {
  return new Date(e).toLocaleTimeString();
}
function gr(e, t) {
  const r = t ?? Date.now(), n = Math.max(0, r - e), o = Math.floor(n / 1e3), s = Math.floor(o / 60), a = Math.floor(s / 60), i = [];
  return a && i.push(`${a}h`), (s % 60 || !a) && i.push(`${s % 60}m`), !a && s < 5 && i.push(`${o % 60}s`), i.join(" ");
}
function br(e, t = 28) {
  return e.length <= t ? e : `…${e.slice(-t)}`;
}
function gn(e, t = 120) {
  return e.length <= t ? e : `${e.slice(0, t - 1)}…`;
}
function mr(e) {
  var t, r, n = "";
  if (typeof e == "string" || typeof e == "number") n += e;
  else if (typeof e == "object") if (Array.isArray(e)) {
    var o = e.length;
    for (t = 0; t < o; t++) e[t] && (r = mr(e[t])) && (n && (n += " "), n += r);
  } else for (r in e) e[r] && (n && (n += " "), n += r);
  return n;
}
function bn() {
  for (var e, t, r = 0, n = "", o = arguments.length; r < o; r++) (e = arguments[r]) && (t = mr(e)) && (n && (n += " "), n += t);
  return n;
}
const kt = "-", mn = (e) => {
  const t = vn(e), {
    conflictingClassGroups: r,
    conflictingClassGroupModifiers: n
  } = e;
  return {
    getClassGroupId: (a) => {
      const i = a.split(kt);
      return i[0] === "" && i.length !== 1 && i.shift(), wr(i, t) || wn(a);
    },
    getConflictingClassGroupIds: (a, i) => {
      const l = r[a] || [];
      return i && n[a] ? [...l, ...n[a]] : l;
    }
  };
}, wr = (e, t) => {
  if (e.length === 0)
    return t.classGroupId;
  const r = e[0], n = t.nextPart.get(r), o = n ? wr(e.slice(1), n) : void 0;
  if (o)
    return o;
  if (t.validators.length === 0)
    return;
  const s = e.join(kt);
  return t.validators.find(({
    validator: a
  }) => a(s))?.classGroupId;
}, Dt = /^\[(.+)\]$/, wn = (e) => {
  if (Dt.test(e)) {
    const t = Dt.exec(e)[1], r = t?.substring(0, t.indexOf(":"));
    if (r)
      return "arbitrary.." + r;
  }
}, vn = (e) => {
  const {
    theme: t,
    prefix: r
  } = e, n = {
    nextPart: /* @__PURE__ */ new Map(),
    validators: []
  };
  return yn(Object.entries(e.classGroups), r).forEach(([s, a]) => {
    bt(a, n, s, t);
  }), n;
}, bt = (e, t, r, n) => {
  e.forEach((o) => {
    if (typeof o == "string") {
      const s = o === "" ? t : Nt(t, o);
      s.classGroupId = r;
      return;
    }
    if (typeof o == "function") {
      if (xn(o)) {
        bt(o(n), t, r, n);
        return;
      }
      t.validators.push({
        validator: o,
        classGroupId: r
      });
      return;
    }
    Object.entries(o).forEach(([s, a]) => {
      bt(a, Nt(t, s), r, n);
    });
  });
}, Nt = (e, t) => {
  let r = e;
  return t.split(kt).forEach((n) => {
    r.nextPart.has(n) || r.nextPart.set(n, {
      nextPart: /* @__PURE__ */ new Map(),
      validators: []
    }), r = r.nextPart.get(n);
  }), r;
}, xn = (e) => e.isThemeGetter, yn = (e, t) => t ? e.map(([r, n]) => {
  const o = n.map((s) => typeof s == "string" ? t + s : typeof s == "object" ? Object.fromEntries(Object.entries(s).map(([a, i]) => [t + a, i])) : s);
  return [r, o];
}) : e, $n = (e) => {
  if (e < 1)
    return {
      get: () => {
      },
      set: () => {
      }
    };
  let t = 0, r = /* @__PURE__ */ new Map(), n = /* @__PURE__ */ new Map();
  const o = (s, a) => {
    r.set(s, a), t++, t > e && (t = 0, n = r, r = /* @__PURE__ */ new Map());
  };
  return {
    get(s) {
      let a = r.get(s);
      if (a !== void 0)
        return a;
      if ((a = n.get(s)) !== void 0)
        return o(s, a), a;
    },
    set(s, a) {
      r.has(s) ? r.set(s, a) : o(s, a);
    }
  };
}, vr = "!", kn = (e) => {
  const {
    separator: t,
    experimentalParseClassName: r
  } = e, n = t.length === 1, o = t[0], s = t.length, a = (i) => {
    const l = [];
    let c = 0, d = 0, u;
    for (let b = 0; b < i.length; b++) {
      let _ = i[b];
      if (c === 0) {
        if (_ === o && (n || i.slice(b, b + s) === t)) {
          l.push(i.slice(d, b)), d = b + s;
          continue;
        }
        if (_ === "/") {
          u = b;
          continue;
        }
      }
      _ === "[" ? c++ : _ === "]" && c--;
    }
    const h = l.length === 0 ? i : i.substring(d), g = h.startsWith(vr), m = g ? h.substring(1) : h, p = u && u > d ? u - d : void 0;
    return {
      modifiers: l,
      hasImportantModifier: g,
      baseClassName: m,
      maybePostfixModifierPosition: p
    };
  };
  return r ? (i) => r({
    className: i,
    parseClassName: a
  }) : a;
}, Sn = (e) => {
  if (e.length <= 1)
    return e;
  const t = [];
  let r = [];
  return e.forEach((n) => {
    n[0] === "[" ? (t.push(...r.sort(), n), r = []) : r.push(n);
  }), t.push(...r.sort()), t;
}, _n = (e) => ({
  cache: $n(e.cacheSize),
  parseClassName: kn(e),
  ...mn(e)
}), Cn = /\s+/, In = (e, t) => {
  const {
    parseClassName: r,
    getClassGroupId: n,
    getConflictingClassGroupIds: o
  } = t, s = [], a = e.trim().split(Cn);
  let i = "";
  for (let l = a.length - 1; l >= 0; l -= 1) {
    const c = a[l], {
      modifiers: d,
      hasImportantModifier: u,
      baseClassName: h,
      maybePostfixModifierPosition: g
    } = r(c);
    let m = !!g, p = n(m ? h.substring(0, g) : h);
    if (!p) {
      if (!m) {
        i = c + (i.length > 0 ? " " + i : i);
        continue;
      }
      if (p = n(h), !p) {
        i = c + (i.length > 0 ? " " + i : i);
        continue;
      }
      m = !1;
    }
    const b = Sn(d).join(":"), _ = u ? b + vr : b, y = _ + p;
    if (s.includes(y))
      continue;
    s.push(y);
    const I = o(p, m);
    for (let x = 0; x < I.length; ++x) {
      const R = I[x];
      s.push(_ + R);
    }
    i = c + (i.length > 0 ? " " + i : i);
  }
  return i;
};
function An() {
  let e = 0, t, r, n = "";
  for (; e < arguments.length; )
    (t = arguments[e++]) && (r = xr(t)) && (n && (n += " "), n += r);
  return n;
}
const xr = (e) => {
  if (typeof e == "string")
    return e;
  let t, r = "";
  for (let n = 0; n < e.length; n++)
    e[n] && (t = xr(e[n])) && (r && (r += " "), r += t);
  return r;
};
function Rn(e, ...t) {
  let r, n, o, s = a;
  function a(l) {
    const c = t.reduce((d, u) => u(d), e());
    return r = _n(c), n = r.cache.get, o = r.cache.set, s = i, i(l);
  }
  function i(l) {
    const c = n(l);
    if (c)
      return c;
    const d = In(l, r);
    return o(l, d), d;
  }
  return function() {
    return s(An.apply(null, arguments));
  };
}
const z = (e) => {
  const t = (r) => r[e] || [];
  return t.isThemeGetter = !0, t;
}, yr = /^\[(?:([a-z-]+):)?(.+)\]$/i, On = /^\d+\/\d+$/, Pn = /* @__PURE__ */ new Set(["px", "full", "screen"]), Tn = /^(\d+(\.\d+)?)?(xs|sm|md|lg|xl)$/, En = /\d+(%|px|r?em|[sdl]?v([hwib]|min|max)|pt|pc|in|cm|mm|cap|ch|ex|r?lh|cq(w|h|i|b|min|max))|\b(calc|min|max|clamp)\(.+\)|^0$/, Mn = /^(rgba?|hsla?|hwb|(ok)?(lab|lch)|color-mix)\(.+\)$/, qn = /^(inset_)?-?((\d+)?\.?(\d+)[a-z]+|0)_-?((\d+)?\.?(\d+)[a-z]+|0)/, Fn = /^(url|image|image-set|cross-fade|element|(repeating-)?(linear|radial|conic)-gradient)\(.+\)$/, de = (e) => ye(e) || Pn.has(e) || On.test(e), ge = (e) => Se(e, "length", Hn), ye = (e) => !!e && !Number.isNaN(Number(e)), ut = (e) => Se(e, "number", ye), Ie = (e) => !!e && Number.isInteger(Number(e)), Dn = (e) => e.endsWith("%") && ye(e.slice(0, -1)), M = (e) => yr.test(e), be = (e) => Tn.test(e), Nn = /* @__PURE__ */ new Set(["length", "size", "percentage"]), Ln = (e) => Se(e, Nn, $r), jn = (e) => Se(e, "position", $r), Wn = /* @__PURE__ */ new Set(["image", "url"]), zn = (e) => Se(e, Wn, Un), Qn = (e) => Se(e, "", Bn), Ae = () => !0, Se = (e, t, r) => {
  const n = yr.exec(e);
  return n ? n[1] ? typeof t == "string" ? n[1] === t : t.has(n[1]) : r(n[2]) : !1;
}, Hn = (e) => (
  // `colorFunctionRegex` check is necessary because color functions can have percentages in them which which would be incorrectly classified as lengths.
  // For example, `hsl(0 0% 0%)` would be classified as a length without this check.
  // I could also use lookbehind assertion in `lengthUnitRegex` but that isn't supported widely enough.
  En.test(e) && !Mn.test(e)
), $r = () => !1, Bn = (e) => qn.test(e), Un = (e) => Fn.test(e), Kn = () => {
  const e = z("colors"), t = z("spacing"), r = z("blur"), n = z("brightness"), o = z("borderColor"), s = z("borderRadius"), a = z("borderSpacing"), i = z("borderWidth"), l = z("contrast"), c = z("grayscale"), d = z("hueRotate"), u = z("invert"), h = z("gap"), g = z("gradientColorStops"), m = z("gradientColorStopPositions"), p = z("inset"), b = z("margin"), _ = z("opacity"), y = z("padding"), I = z("saturate"), x = z("scale"), R = z("sepia"), F = z("skew"), H = z("space"), k = z("translate"), v = () => ["auto", "contain", "none"], O = () => ["auto", "hidden", "clip", "visible", "scroll"], C = () => ["auto", M, t], A = () => [M, t], D = () => ["", de, ge], N = () => ["auto", ye, M], Z = () => ["bottom", "center", "left", "left-bottom", "left-top", "right", "right-bottom", "right-top", "top"], ne = () => ["solid", "dashed", "dotted", "double", "none"], P = () => ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"], U = () => ["start", "end", "center", "between", "around", "evenly", "stretch"], Y = () => ["", "0", M], j = () => ["auto", "avoid", "all", "avoid-page", "page", "left", "right", "column"], ee = () => [ye, M];
  return {
    cacheSize: 500,
    separator: ":",
    theme: {
      colors: [Ae],
      spacing: [de, ge],
      blur: ["none", "", be, M],
      brightness: ee(),
      borderColor: [e],
      borderRadius: ["none", "", "full", be, M],
      borderSpacing: A(),
      borderWidth: D(),
      contrast: ee(),
      grayscale: Y(),
      hueRotate: ee(),
      invert: Y(),
      gap: A(),
      gradientColorStops: [e],
      gradientColorStopPositions: [Dn, ge],
      inset: C(),
      margin: C(),
      opacity: ee(),
      padding: A(),
      saturate: ee(),
      scale: ee(),
      sepia: Y(),
      skew: ee(),
      space: A(),
      translate: A()
    },
    classGroups: {
      // Layout
      /**
       * Aspect Ratio
       * @see https://tailwindcss.com/docs/aspect-ratio
       */
      aspect: [{
        aspect: ["auto", "square", "video", M]
      }],
      /**
       * Container
       * @see https://tailwindcss.com/docs/container
       */
      container: ["container"],
      /**
       * Columns
       * @see https://tailwindcss.com/docs/columns
       */
      columns: [{
        columns: [be]
      }],
      /**
       * Break After
       * @see https://tailwindcss.com/docs/break-after
       */
      "break-after": [{
        "break-after": j()
      }],
      /**
       * Break Before
       * @see https://tailwindcss.com/docs/break-before
       */
      "break-before": [{
        "break-before": j()
      }],
      /**
       * Break Inside
       * @see https://tailwindcss.com/docs/break-inside
       */
      "break-inside": [{
        "break-inside": ["auto", "avoid", "avoid-page", "avoid-column"]
      }],
      /**
       * Box Decoration Break
       * @see https://tailwindcss.com/docs/box-decoration-break
       */
      "box-decoration": [{
        "box-decoration": ["slice", "clone"]
      }],
      /**
       * Box Sizing
       * @see https://tailwindcss.com/docs/box-sizing
       */
      box: [{
        box: ["border", "content"]
      }],
      /**
       * Display
       * @see https://tailwindcss.com/docs/display
       */
      display: ["block", "inline-block", "inline", "flex", "inline-flex", "table", "inline-table", "table-caption", "table-cell", "table-column", "table-column-group", "table-footer-group", "table-header-group", "table-row-group", "table-row", "flow-root", "grid", "inline-grid", "contents", "list-item", "hidden"],
      /**
       * Floats
       * @see https://tailwindcss.com/docs/float
       */
      float: [{
        float: ["right", "left", "none", "start", "end"]
      }],
      /**
       * Clear
       * @see https://tailwindcss.com/docs/clear
       */
      clear: [{
        clear: ["left", "right", "both", "none", "start", "end"]
      }],
      /**
       * Isolation
       * @see https://tailwindcss.com/docs/isolation
       */
      isolation: ["isolate", "isolation-auto"],
      /**
       * Object Fit
       * @see https://tailwindcss.com/docs/object-fit
       */
      "object-fit": [{
        object: ["contain", "cover", "fill", "none", "scale-down"]
      }],
      /**
       * Object Position
       * @see https://tailwindcss.com/docs/object-position
       */
      "object-position": [{
        object: [...Z(), M]
      }],
      /**
       * Overflow
       * @see https://tailwindcss.com/docs/overflow
       */
      overflow: [{
        overflow: O()
      }],
      /**
       * Overflow X
       * @see https://tailwindcss.com/docs/overflow
       */
      "overflow-x": [{
        "overflow-x": O()
      }],
      /**
       * Overflow Y
       * @see https://tailwindcss.com/docs/overflow
       */
      "overflow-y": [{
        "overflow-y": O()
      }],
      /**
       * Overscroll Behavior
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      overscroll: [{
        overscroll: v()
      }],
      /**
       * Overscroll Behavior X
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      "overscroll-x": [{
        "overscroll-x": v()
      }],
      /**
       * Overscroll Behavior Y
       * @see https://tailwindcss.com/docs/overscroll-behavior
       */
      "overscroll-y": [{
        "overscroll-y": v()
      }],
      /**
       * Position
       * @see https://tailwindcss.com/docs/position
       */
      position: ["static", "fixed", "absolute", "relative", "sticky"],
      /**
       * Top / Right / Bottom / Left
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      inset: [{
        inset: [p]
      }],
      /**
       * Right / Left
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-x": [{
        "inset-x": [p]
      }],
      /**
       * Top / Bottom
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      "inset-y": [{
        "inset-y": [p]
      }],
      /**
       * Start
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      start: [{
        start: [p]
      }],
      /**
       * End
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      end: [{
        end: [p]
      }],
      /**
       * Top
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      top: [{
        top: [p]
      }],
      /**
       * Right
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      right: [{
        right: [p]
      }],
      /**
       * Bottom
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      bottom: [{
        bottom: [p]
      }],
      /**
       * Left
       * @see https://tailwindcss.com/docs/top-right-bottom-left
       */
      left: [{
        left: [p]
      }],
      /**
       * Visibility
       * @see https://tailwindcss.com/docs/visibility
       */
      visibility: ["visible", "invisible", "collapse"],
      /**
       * Z-Index
       * @see https://tailwindcss.com/docs/z-index
       */
      z: [{
        z: ["auto", Ie, M]
      }],
      // Flexbox and Grid
      /**
       * Flex Basis
       * @see https://tailwindcss.com/docs/flex-basis
       */
      basis: [{
        basis: C()
      }],
      /**
       * Flex Direction
       * @see https://tailwindcss.com/docs/flex-direction
       */
      "flex-direction": [{
        flex: ["row", "row-reverse", "col", "col-reverse"]
      }],
      /**
       * Flex Wrap
       * @see https://tailwindcss.com/docs/flex-wrap
       */
      "flex-wrap": [{
        flex: ["wrap", "wrap-reverse", "nowrap"]
      }],
      /**
       * Flex
       * @see https://tailwindcss.com/docs/flex
       */
      flex: [{
        flex: ["1", "auto", "initial", "none", M]
      }],
      /**
       * Flex Grow
       * @see https://tailwindcss.com/docs/flex-grow
       */
      grow: [{
        grow: Y()
      }],
      /**
       * Flex Shrink
       * @see https://tailwindcss.com/docs/flex-shrink
       */
      shrink: [{
        shrink: Y()
      }],
      /**
       * Order
       * @see https://tailwindcss.com/docs/order
       */
      order: [{
        order: ["first", "last", "none", Ie, M]
      }],
      /**
       * Grid Template Columns
       * @see https://tailwindcss.com/docs/grid-template-columns
       */
      "grid-cols": [{
        "grid-cols": [Ae]
      }],
      /**
       * Grid Column Start / End
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-start-end": [{
        col: ["auto", {
          span: ["full", Ie, M]
        }, M]
      }],
      /**
       * Grid Column Start
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-start": [{
        "col-start": N()
      }],
      /**
       * Grid Column End
       * @see https://tailwindcss.com/docs/grid-column
       */
      "col-end": [{
        "col-end": N()
      }],
      /**
       * Grid Template Rows
       * @see https://tailwindcss.com/docs/grid-template-rows
       */
      "grid-rows": [{
        "grid-rows": [Ae]
      }],
      /**
       * Grid Row Start / End
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-start-end": [{
        row: ["auto", {
          span: [Ie, M]
        }, M]
      }],
      /**
       * Grid Row Start
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-start": [{
        "row-start": N()
      }],
      /**
       * Grid Row End
       * @see https://tailwindcss.com/docs/grid-row
       */
      "row-end": [{
        "row-end": N()
      }],
      /**
       * Grid Auto Flow
       * @see https://tailwindcss.com/docs/grid-auto-flow
       */
      "grid-flow": [{
        "grid-flow": ["row", "col", "dense", "row-dense", "col-dense"]
      }],
      /**
       * Grid Auto Columns
       * @see https://tailwindcss.com/docs/grid-auto-columns
       */
      "auto-cols": [{
        "auto-cols": ["auto", "min", "max", "fr", M]
      }],
      /**
       * Grid Auto Rows
       * @see https://tailwindcss.com/docs/grid-auto-rows
       */
      "auto-rows": [{
        "auto-rows": ["auto", "min", "max", "fr", M]
      }],
      /**
       * Gap
       * @see https://tailwindcss.com/docs/gap
       */
      gap: [{
        gap: [h]
      }],
      /**
       * Gap X
       * @see https://tailwindcss.com/docs/gap
       */
      "gap-x": [{
        "gap-x": [h]
      }],
      /**
       * Gap Y
       * @see https://tailwindcss.com/docs/gap
       */
      "gap-y": [{
        "gap-y": [h]
      }],
      /**
       * Justify Content
       * @see https://tailwindcss.com/docs/justify-content
       */
      "justify-content": [{
        justify: ["normal", ...U()]
      }],
      /**
       * Justify Items
       * @see https://tailwindcss.com/docs/justify-items
       */
      "justify-items": [{
        "justify-items": ["start", "end", "center", "stretch"]
      }],
      /**
       * Justify Self
       * @see https://tailwindcss.com/docs/justify-self
       */
      "justify-self": [{
        "justify-self": ["auto", "start", "end", "center", "stretch"]
      }],
      /**
       * Align Content
       * @see https://tailwindcss.com/docs/align-content
       */
      "align-content": [{
        content: ["normal", ...U(), "baseline"]
      }],
      /**
       * Align Items
       * @see https://tailwindcss.com/docs/align-items
       */
      "align-items": [{
        items: ["start", "end", "center", "baseline", "stretch"]
      }],
      /**
       * Align Self
       * @see https://tailwindcss.com/docs/align-self
       */
      "align-self": [{
        self: ["auto", "start", "end", "center", "stretch", "baseline"]
      }],
      /**
       * Place Content
       * @see https://tailwindcss.com/docs/place-content
       */
      "place-content": [{
        "place-content": [...U(), "baseline"]
      }],
      /**
       * Place Items
       * @see https://tailwindcss.com/docs/place-items
       */
      "place-items": [{
        "place-items": ["start", "end", "center", "baseline", "stretch"]
      }],
      /**
       * Place Self
       * @see https://tailwindcss.com/docs/place-self
       */
      "place-self": [{
        "place-self": ["auto", "start", "end", "center", "stretch"]
      }],
      // Spacing
      /**
       * Padding
       * @see https://tailwindcss.com/docs/padding
       */
      p: [{
        p: [y]
      }],
      /**
       * Padding X
       * @see https://tailwindcss.com/docs/padding
       */
      px: [{
        px: [y]
      }],
      /**
       * Padding Y
       * @see https://tailwindcss.com/docs/padding
       */
      py: [{
        py: [y]
      }],
      /**
       * Padding Start
       * @see https://tailwindcss.com/docs/padding
       */
      ps: [{
        ps: [y]
      }],
      /**
       * Padding End
       * @see https://tailwindcss.com/docs/padding
       */
      pe: [{
        pe: [y]
      }],
      /**
       * Padding Top
       * @see https://tailwindcss.com/docs/padding
       */
      pt: [{
        pt: [y]
      }],
      /**
       * Padding Right
       * @see https://tailwindcss.com/docs/padding
       */
      pr: [{
        pr: [y]
      }],
      /**
       * Padding Bottom
       * @see https://tailwindcss.com/docs/padding
       */
      pb: [{
        pb: [y]
      }],
      /**
       * Padding Left
       * @see https://tailwindcss.com/docs/padding
       */
      pl: [{
        pl: [y]
      }],
      /**
       * Margin
       * @see https://tailwindcss.com/docs/margin
       */
      m: [{
        m: [b]
      }],
      /**
       * Margin X
       * @see https://tailwindcss.com/docs/margin
       */
      mx: [{
        mx: [b]
      }],
      /**
       * Margin Y
       * @see https://tailwindcss.com/docs/margin
       */
      my: [{
        my: [b]
      }],
      /**
       * Margin Start
       * @see https://tailwindcss.com/docs/margin
       */
      ms: [{
        ms: [b]
      }],
      /**
       * Margin End
       * @see https://tailwindcss.com/docs/margin
       */
      me: [{
        me: [b]
      }],
      /**
       * Margin Top
       * @see https://tailwindcss.com/docs/margin
       */
      mt: [{
        mt: [b]
      }],
      /**
       * Margin Right
       * @see https://tailwindcss.com/docs/margin
       */
      mr: [{
        mr: [b]
      }],
      /**
       * Margin Bottom
       * @see https://tailwindcss.com/docs/margin
       */
      mb: [{
        mb: [b]
      }],
      /**
       * Margin Left
       * @see https://tailwindcss.com/docs/margin
       */
      ml: [{
        ml: [b]
      }],
      /**
       * Space Between X
       * @see https://tailwindcss.com/docs/space
       */
      "space-x": [{
        "space-x": [H]
      }],
      /**
       * Space Between X Reverse
       * @see https://tailwindcss.com/docs/space
       */
      "space-x-reverse": ["space-x-reverse"],
      /**
       * Space Between Y
       * @see https://tailwindcss.com/docs/space
       */
      "space-y": [{
        "space-y": [H]
      }],
      /**
       * Space Between Y Reverse
       * @see https://tailwindcss.com/docs/space
       */
      "space-y-reverse": ["space-y-reverse"],
      // Sizing
      /**
       * Width
       * @see https://tailwindcss.com/docs/width
       */
      w: [{
        w: ["auto", "min", "max", "fit", "svw", "lvw", "dvw", M, t]
      }],
      /**
       * Min-Width
       * @see https://tailwindcss.com/docs/min-width
       */
      "min-w": [{
        "min-w": [M, t, "min", "max", "fit"]
      }],
      /**
       * Max-Width
       * @see https://tailwindcss.com/docs/max-width
       */
      "max-w": [{
        "max-w": [M, t, "none", "full", "min", "max", "fit", "prose", {
          screen: [be]
        }, be]
      }],
      /**
       * Height
       * @see https://tailwindcss.com/docs/height
       */
      h: [{
        h: [M, t, "auto", "min", "max", "fit", "svh", "lvh", "dvh"]
      }],
      /**
       * Min-Height
       * @see https://tailwindcss.com/docs/min-height
       */
      "min-h": [{
        "min-h": [M, t, "min", "max", "fit", "svh", "lvh", "dvh"]
      }],
      /**
       * Max-Height
       * @see https://tailwindcss.com/docs/max-height
       */
      "max-h": [{
        "max-h": [M, t, "min", "max", "fit", "svh", "lvh", "dvh"]
      }],
      /**
       * Size
       * @see https://tailwindcss.com/docs/size
       */
      size: [{
        size: [M, t, "auto", "min", "max", "fit"]
      }],
      // Typography
      /**
       * Font Size
       * @see https://tailwindcss.com/docs/font-size
       */
      "font-size": [{
        text: ["base", be, ge]
      }],
      /**
       * Font Smoothing
       * @see https://tailwindcss.com/docs/font-smoothing
       */
      "font-smoothing": ["antialiased", "subpixel-antialiased"],
      /**
       * Font Style
       * @see https://tailwindcss.com/docs/font-style
       */
      "font-style": ["italic", "not-italic"],
      /**
       * Font Weight
       * @see https://tailwindcss.com/docs/font-weight
       */
      "font-weight": [{
        font: ["thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black", ut]
      }],
      /**
       * Font Family
       * @see https://tailwindcss.com/docs/font-family
       */
      "font-family": [{
        font: [Ae]
      }],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-normal": ["normal-nums"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-ordinal": ["ordinal"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-slashed-zero": ["slashed-zero"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-figure": ["lining-nums", "oldstyle-nums"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-spacing": ["proportional-nums", "tabular-nums"],
      /**
       * Font Variant Numeric
       * @see https://tailwindcss.com/docs/font-variant-numeric
       */
      "fvn-fraction": ["diagonal-fractions", "stacked-fractions"],
      /**
       * Letter Spacing
       * @see https://tailwindcss.com/docs/letter-spacing
       */
      tracking: [{
        tracking: ["tighter", "tight", "normal", "wide", "wider", "widest", M]
      }],
      /**
       * Line Clamp
       * @see https://tailwindcss.com/docs/line-clamp
       */
      "line-clamp": [{
        "line-clamp": ["none", ye, ut]
      }],
      /**
       * Line Height
       * @see https://tailwindcss.com/docs/line-height
       */
      leading: [{
        leading: ["none", "tight", "snug", "normal", "relaxed", "loose", de, M]
      }],
      /**
       * List Style Image
       * @see https://tailwindcss.com/docs/list-style-image
       */
      "list-image": [{
        "list-image": ["none", M]
      }],
      /**
       * List Style Type
       * @see https://tailwindcss.com/docs/list-style-type
       */
      "list-style-type": [{
        list: ["none", "disc", "decimal", M]
      }],
      /**
       * List Style Position
       * @see https://tailwindcss.com/docs/list-style-position
       */
      "list-style-position": [{
        list: ["inside", "outside"]
      }],
      /**
       * Placeholder Color
       * @deprecated since Tailwind CSS v3.0.0
       * @see https://tailwindcss.com/docs/placeholder-color
       */
      "placeholder-color": [{
        placeholder: [e]
      }],
      /**
       * Placeholder Opacity
       * @see https://tailwindcss.com/docs/placeholder-opacity
       */
      "placeholder-opacity": [{
        "placeholder-opacity": [_]
      }],
      /**
       * Text Alignment
       * @see https://tailwindcss.com/docs/text-align
       */
      "text-alignment": [{
        text: ["left", "center", "right", "justify", "start", "end"]
      }],
      /**
       * Text Color
       * @see https://tailwindcss.com/docs/text-color
       */
      "text-color": [{
        text: [e]
      }],
      /**
       * Text Opacity
       * @see https://tailwindcss.com/docs/text-opacity
       */
      "text-opacity": [{
        "text-opacity": [_]
      }],
      /**
       * Text Decoration
       * @see https://tailwindcss.com/docs/text-decoration
       */
      "text-decoration": ["underline", "overline", "line-through", "no-underline"],
      /**
       * Text Decoration Style
       * @see https://tailwindcss.com/docs/text-decoration-style
       */
      "text-decoration-style": [{
        decoration: [...ne(), "wavy"]
      }],
      /**
       * Text Decoration Thickness
       * @see https://tailwindcss.com/docs/text-decoration-thickness
       */
      "text-decoration-thickness": [{
        decoration: ["auto", "from-font", de, ge]
      }],
      /**
       * Text Underline Offset
       * @see https://tailwindcss.com/docs/text-underline-offset
       */
      "underline-offset": [{
        "underline-offset": ["auto", de, M]
      }],
      /**
       * Text Decoration Color
       * @see https://tailwindcss.com/docs/text-decoration-color
       */
      "text-decoration-color": [{
        decoration: [e]
      }],
      /**
       * Text Transform
       * @see https://tailwindcss.com/docs/text-transform
       */
      "text-transform": ["uppercase", "lowercase", "capitalize", "normal-case"],
      /**
       * Text Overflow
       * @see https://tailwindcss.com/docs/text-overflow
       */
      "text-overflow": ["truncate", "text-ellipsis", "text-clip"],
      /**
       * Text Wrap
       * @see https://tailwindcss.com/docs/text-wrap
       */
      "text-wrap": [{
        text: ["wrap", "nowrap", "balance", "pretty"]
      }],
      /**
       * Text Indent
       * @see https://tailwindcss.com/docs/text-indent
       */
      indent: [{
        indent: A()
      }],
      /**
       * Vertical Alignment
       * @see https://tailwindcss.com/docs/vertical-align
       */
      "vertical-align": [{
        align: ["baseline", "top", "middle", "bottom", "text-top", "text-bottom", "sub", "super", M]
      }],
      /**
       * Whitespace
       * @see https://tailwindcss.com/docs/whitespace
       */
      whitespace: [{
        whitespace: ["normal", "nowrap", "pre", "pre-line", "pre-wrap", "break-spaces"]
      }],
      /**
       * Word Break
       * @see https://tailwindcss.com/docs/word-break
       */
      break: [{
        break: ["normal", "words", "all", "keep"]
      }],
      /**
       * Hyphens
       * @see https://tailwindcss.com/docs/hyphens
       */
      hyphens: [{
        hyphens: ["none", "manual", "auto"]
      }],
      /**
       * Content
       * @see https://tailwindcss.com/docs/content
       */
      content: [{
        content: ["none", M]
      }],
      // Backgrounds
      /**
       * Background Attachment
       * @see https://tailwindcss.com/docs/background-attachment
       */
      "bg-attachment": [{
        bg: ["fixed", "local", "scroll"]
      }],
      /**
       * Background Clip
       * @see https://tailwindcss.com/docs/background-clip
       */
      "bg-clip": [{
        "bg-clip": ["border", "padding", "content", "text"]
      }],
      /**
       * Background Opacity
       * @deprecated since Tailwind CSS v3.0.0
       * @see https://tailwindcss.com/docs/background-opacity
       */
      "bg-opacity": [{
        "bg-opacity": [_]
      }],
      /**
       * Background Origin
       * @see https://tailwindcss.com/docs/background-origin
       */
      "bg-origin": [{
        "bg-origin": ["border", "padding", "content"]
      }],
      /**
       * Background Position
       * @see https://tailwindcss.com/docs/background-position
       */
      "bg-position": [{
        bg: [...Z(), jn]
      }],
      /**
       * Background Repeat
       * @see https://tailwindcss.com/docs/background-repeat
       */
      "bg-repeat": [{
        bg: ["no-repeat", {
          repeat: ["", "x", "y", "round", "space"]
        }]
      }],
      /**
       * Background Size
       * @see https://tailwindcss.com/docs/background-size
       */
      "bg-size": [{
        bg: ["auto", "cover", "contain", Ln]
      }],
      /**
       * Background Image
       * @see https://tailwindcss.com/docs/background-image
       */
      "bg-image": [{
        bg: ["none", {
          "gradient-to": ["t", "tr", "r", "br", "b", "bl", "l", "tl"]
        }, zn]
      }],
      /**
       * Background Color
       * @see https://tailwindcss.com/docs/background-color
       */
      "bg-color": [{
        bg: [e]
      }],
      /**
       * Gradient Color Stops From Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-from-pos": [{
        from: [m]
      }],
      /**
       * Gradient Color Stops Via Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-via-pos": [{
        via: [m]
      }],
      /**
       * Gradient Color Stops To Position
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-to-pos": [{
        to: [m]
      }],
      /**
       * Gradient Color Stops From
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-from": [{
        from: [g]
      }],
      /**
       * Gradient Color Stops Via
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-via": [{
        via: [g]
      }],
      /**
       * Gradient Color Stops To
       * @see https://tailwindcss.com/docs/gradient-color-stops
       */
      "gradient-to": [{
        to: [g]
      }],
      // Borders
      /**
       * Border Radius
       * @see https://tailwindcss.com/docs/border-radius
       */
      rounded: [{
        rounded: [s]
      }],
      /**
       * Border Radius Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-s": [{
        "rounded-s": [s]
      }],
      /**
       * Border Radius End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-e": [{
        "rounded-e": [s]
      }],
      /**
       * Border Radius Top
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-t": [{
        "rounded-t": [s]
      }],
      /**
       * Border Radius Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-r": [{
        "rounded-r": [s]
      }],
      /**
       * Border Radius Bottom
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-b": [{
        "rounded-b": [s]
      }],
      /**
       * Border Radius Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-l": [{
        "rounded-l": [s]
      }],
      /**
       * Border Radius Start Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-ss": [{
        "rounded-ss": [s]
      }],
      /**
       * Border Radius Start End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-se": [{
        "rounded-se": [s]
      }],
      /**
       * Border Radius End End
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-ee": [{
        "rounded-ee": [s]
      }],
      /**
       * Border Radius End Start
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-es": [{
        "rounded-es": [s]
      }],
      /**
       * Border Radius Top Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-tl": [{
        "rounded-tl": [s]
      }],
      /**
       * Border Radius Top Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-tr": [{
        "rounded-tr": [s]
      }],
      /**
       * Border Radius Bottom Right
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-br": [{
        "rounded-br": [s]
      }],
      /**
       * Border Radius Bottom Left
       * @see https://tailwindcss.com/docs/border-radius
       */
      "rounded-bl": [{
        "rounded-bl": [s]
      }],
      /**
       * Border Width
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w": [{
        border: [i]
      }],
      /**
       * Border Width X
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-x": [{
        "border-x": [i]
      }],
      /**
       * Border Width Y
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-y": [{
        "border-y": [i]
      }],
      /**
       * Border Width Start
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-s": [{
        "border-s": [i]
      }],
      /**
       * Border Width End
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-e": [{
        "border-e": [i]
      }],
      /**
       * Border Width Top
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-t": [{
        "border-t": [i]
      }],
      /**
       * Border Width Right
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-r": [{
        "border-r": [i]
      }],
      /**
       * Border Width Bottom
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-b": [{
        "border-b": [i]
      }],
      /**
       * Border Width Left
       * @see https://tailwindcss.com/docs/border-width
       */
      "border-w-l": [{
        "border-l": [i]
      }],
      /**
       * Border Opacity
       * @see https://tailwindcss.com/docs/border-opacity
       */
      "border-opacity": [{
        "border-opacity": [_]
      }],
      /**
       * Border Style
       * @see https://tailwindcss.com/docs/border-style
       */
      "border-style": [{
        border: [...ne(), "hidden"]
      }],
      /**
       * Divide Width X
       * @see https://tailwindcss.com/docs/divide-width
       */
      "divide-x": [{
        "divide-x": [i]
      }],
      /**
       * Divide Width X Reverse
       * @see https://tailwindcss.com/docs/divide-width
       */
      "divide-x-reverse": ["divide-x-reverse"],
      /**
       * Divide Width Y
       * @see https://tailwindcss.com/docs/divide-width
       */
      "divide-y": [{
        "divide-y": [i]
      }],
      /**
       * Divide Width Y Reverse
       * @see https://tailwindcss.com/docs/divide-width
       */
      "divide-y-reverse": ["divide-y-reverse"],
      /**
       * Divide Opacity
       * @see https://tailwindcss.com/docs/divide-opacity
       */
      "divide-opacity": [{
        "divide-opacity": [_]
      }],
      /**
       * Divide Style
       * @see https://tailwindcss.com/docs/divide-style
       */
      "divide-style": [{
        divide: ne()
      }],
      /**
       * Border Color
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color": [{
        border: [o]
      }],
      /**
       * Border Color X
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-x": [{
        "border-x": [o]
      }],
      /**
       * Border Color Y
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-y": [{
        "border-y": [o]
      }],
      /**
       * Border Color S
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-s": [{
        "border-s": [o]
      }],
      /**
       * Border Color E
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-e": [{
        "border-e": [o]
      }],
      /**
       * Border Color Top
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-t": [{
        "border-t": [o]
      }],
      /**
       * Border Color Right
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-r": [{
        "border-r": [o]
      }],
      /**
       * Border Color Bottom
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-b": [{
        "border-b": [o]
      }],
      /**
       * Border Color Left
       * @see https://tailwindcss.com/docs/border-color
       */
      "border-color-l": [{
        "border-l": [o]
      }],
      /**
       * Divide Color
       * @see https://tailwindcss.com/docs/divide-color
       */
      "divide-color": [{
        divide: [o]
      }],
      /**
       * Outline Style
       * @see https://tailwindcss.com/docs/outline-style
       */
      "outline-style": [{
        outline: ["", ...ne()]
      }],
      /**
       * Outline Offset
       * @see https://tailwindcss.com/docs/outline-offset
       */
      "outline-offset": [{
        "outline-offset": [de, M]
      }],
      /**
       * Outline Width
       * @see https://tailwindcss.com/docs/outline-width
       */
      "outline-w": [{
        outline: [de, ge]
      }],
      /**
       * Outline Color
       * @see https://tailwindcss.com/docs/outline-color
       */
      "outline-color": [{
        outline: [e]
      }],
      /**
       * Ring Width
       * @see https://tailwindcss.com/docs/ring-width
       */
      "ring-w": [{
        ring: D()
      }],
      /**
       * Ring Width Inset
       * @see https://tailwindcss.com/docs/ring-width
       */
      "ring-w-inset": ["ring-inset"],
      /**
       * Ring Color
       * @see https://tailwindcss.com/docs/ring-color
       */
      "ring-color": [{
        ring: [e]
      }],
      /**
       * Ring Opacity
       * @see https://tailwindcss.com/docs/ring-opacity
       */
      "ring-opacity": [{
        "ring-opacity": [_]
      }],
      /**
       * Ring Offset Width
       * @see https://tailwindcss.com/docs/ring-offset-width
       */
      "ring-offset-w": [{
        "ring-offset": [de, ge]
      }],
      /**
       * Ring Offset Color
       * @see https://tailwindcss.com/docs/ring-offset-color
       */
      "ring-offset-color": [{
        "ring-offset": [e]
      }],
      // Effects
      /**
       * Box Shadow
       * @see https://tailwindcss.com/docs/box-shadow
       */
      shadow: [{
        shadow: ["", "inner", "none", be, Qn]
      }],
      /**
       * Box Shadow Color
       * @see https://tailwindcss.com/docs/box-shadow-color
       */
      "shadow-color": [{
        shadow: [Ae]
      }],
      /**
       * Opacity
       * @see https://tailwindcss.com/docs/opacity
       */
      opacity: [{
        opacity: [_]
      }],
      /**
       * Mix Blend Mode
       * @see https://tailwindcss.com/docs/mix-blend-mode
       */
      "mix-blend": [{
        "mix-blend": [...P(), "plus-lighter", "plus-darker"]
      }],
      /**
       * Background Blend Mode
       * @see https://tailwindcss.com/docs/background-blend-mode
       */
      "bg-blend": [{
        "bg-blend": P()
      }],
      // Filters
      /**
       * Filter
       * @deprecated since Tailwind CSS v3.0.0
       * @see https://tailwindcss.com/docs/filter
       */
      filter: [{
        filter: ["", "none"]
      }],
      /**
       * Blur
       * @see https://tailwindcss.com/docs/blur
       */
      blur: [{
        blur: [r]
      }],
      /**
       * Brightness
       * @see https://tailwindcss.com/docs/brightness
       */
      brightness: [{
        brightness: [n]
      }],
      /**
       * Contrast
       * @see https://tailwindcss.com/docs/contrast
       */
      contrast: [{
        contrast: [l]
      }],
      /**
       * Drop Shadow
       * @see https://tailwindcss.com/docs/drop-shadow
       */
      "drop-shadow": [{
        "drop-shadow": ["", "none", be, M]
      }],
      /**
       * Grayscale
       * @see https://tailwindcss.com/docs/grayscale
       */
      grayscale: [{
        grayscale: [c]
      }],
      /**
       * Hue Rotate
       * @see https://tailwindcss.com/docs/hue-rotate
       */
      "hue-rotate": [{
        "hue-rotate": [d]
      }],
      /**
       * Invert
       * @see https://tailwindcss.com/docs/invert
       */
      invert: [{
        invert: [u]
      }],
      /**
       * Saturate
       * @see https://tailwindcss.com/docs/saturate
       */
      saturate: [{
        saturate: [I]
      }],
      /**
       * Sepia
       * @see https://tailwindcss.com/docs/sepia
       */
      sepia: [{
        sepia: [R]
      }],
      /**
       * Backdrop Filter
       * @deprecated since Tailwind CSS v3.0.0
       * @see https://tailwindcss.com/docs/backdrop-filter
       */
      "backdrop-filter": [{
        "backdrop-filter": ["", "none"]
      }],
      /**
       * Backdrop Blur
       * @see https://tailwindcss.com/docs/backdrop-blur
       */
      "backdrop-blur": [{
        "backdrop-blur": [r]
      }],
      /**
       * Backdrop Brightness
       * @see https://tailwindcss.com/docs/backdrop-brightness
       */
      "backdrop-brightness": [{
        "backdrop-brightness": [n]
      }],
      /**
       * Backdrop Contrast
       * @see https://tailwindcss.com/docs/backdrop-contrast
       */
      "backdrop-contrast": [{
        "backdrop-contrast": [l]
      }],
      /**
       * Backdrop Grayscale
       * @see https://tailwindcss.com/docs/backdrop-grayscale
       */
      "backdrop-grayscale": [{
        "backdrop-grayscale": [c]
      }],
      /**
       * Backdrop Hue Rotate
       * @see https://tailwindcss.com/docs/backdrop-hue-rotate
       */
      "backdrop-hue-rotate": [{
        "backdrop-hue-rotate": [d]
      }],
      /**
       * Backdrop Invert
       * @see https://tailwindcss.com/docs/backdrop-invert
       */
      "backdrop-invert": [{
        "backdrop-invert": [u]
      }],
      /**
       * Backdrop Opacity
       * @see https://tailwindcss.com/docs/backdrop-opacity
       */
      "backdrop-opacity": [{
        "backdrop-opacity": [_]
      }],
      /**
       * Backdrop Saturate
       * @see https://tailwindcss.com/docs/backdrop-saturate
       */
      "backdrop-saturate": [{
        "backdrop-saturate": [I]
      }],
      /**
       * Backdrop Sepia
       * @see https://tailwindcss.com/docs/backdrop-sepia
       */
      "backdrop-sepia": [{
        "backdrop-sepia": [R]
      }],
      // Tables
      /**
       * Border Collapse
       * @see https://tailwindcss.com/docs/border-collapse
       */
      "border-collapse": [{
        border: ["collapse", "separate"]
      }],
      /**
       * Border Spacing
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing": [{
        "border-spacing": [a]
      }],
      /**
       * Border Spacing X
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing-x": [{
        "border-spacing-x": [a]
      }],
      /**
       * Border Spacing Y
       * @see https://tailwindcss.com/docs/border-spacing
       */
      "border-spacing-y": [{
        "border-spacing-y": [a]
      }],
      /**
       * Table Layout
       * @see https://tailwindcss.com/docs/table-layout
       */
      "table-layout": [{
        table: ["auto", "fixed"]
      }],
      /**
       * Caption Side
       * @see https://tailwindcss.com/docs/caption-side
       */
      caption: [{
        caption: ["top", "bottom"]
      }],
      // Transitions and Animation
      /**
       * Tranisition Property
       * @see https://tailwindcss.com/docs/transition-property
       */
      transition: [{
        transition: ["none", "all", "", "colors", "opacity", "shadow", "transform", M]
      }],
      /**
       * Transition Duration
       * @see https://tailwindcss.com/docs/transition-duration
       */
      duration: [{
        duration: ee()
      }],
      /**
       * Transition Timing Function
       * @see https://tailwindcss.com/docs/transition-timing-function
       */
      ease: [{
        ease: ["linear", "in", "out", "in-out", M]
      }],
      /**
       * Transition Delay
       * @see https://tailwindcss.com/docs/transition-delay
       */
      delay: [{
        delay: ee()
      }],
      /**
       * Animation
       * @see https://tailwindcss.com/docs/animation
       */
      animate: [{
        animate: ["none", "spin", "ping", "pulse", "bounce", M]
      }],
      // Transforms
      /**
       * Transform
       * @see https://tailwindcss.com/docs/transform
       */
      transform: [{
        transform: ["", "gpu", "none"]
      }],
      /**
       * Scale
       * @see https://tailwindcss.com/docs/scale
       */
      scale: [{
        scale: [x]
      }],
      /**
       * Scale X
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-x": [{
        "scale-x": [x]
      }],
      /**
       * Scale Y
       * @see https://tailwindcss.com/docs/scale
       */
      "scale-y": [{
        "scale-y": [x]
      }],
      /**
       * Rotate
       * @see https://tailwindcss.com/docs/rotate
       */
      rotate: [{
        rotate: [Ie, M]
      }],
      /**
       * Translate X
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-x": [{
        "translate-x": [k]
      }],
      /**
       * Translate Y
       * @see https://tailwindcss.com/docs/translate
       */
      "translate-y": [{
        "translate-y": [k]
      }],
      /**
       * Skew X
       * @see https://tailwindcss.com/docs/skew
       */
      "skew-x": [{
        "skew-x": [F]
      }],
      /**
       * Skew Y
       * @see https://tailwindcss.com/docs/skew
       */
      "skew-y": [{
        "skew-y": [F]
      }],
      /**
       * Transform Origin
       * @see https://tailwindcss.com/docs/transform-origin
       */
      "transform-origin": [{
        origin: ["center", "top", "top-right", "right", "bottom-right", "bottom", "bottom-left", "left", "top-left", M]
      }],
      // Interactivity
      /**
       * Accent Color
       * @see https://tailwindcss.com/docs/accent-color
       */
      accent: [{
        accent: ["auto", e]
      }],
      /**
       * Appearance
       * @see https://tailwindcss.com/docs/appearance
       */
      appearance: [{
        appearance: ["none", "auto"]
      }],
      /**
       * Cursor
       * @see https://tailwindcss.com/docs/cursor
       */
      cursor: [{
        cursor: ["auto", "default", "pointer", "wait", "text", "move", "help", "not-allowed", "none", "context-menu", "progress", "cell", "crosshair", "vertical-text", "alias", "copy", "no-drop", "grab", "grabbing", "all-scroll", "col-resize", "row-resize", "n-resize", "e-resize", "s-resize", "w-resize", "ne-resize", "nw-resize", "se-resize", "sw-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize", "zoom-in", "zoom-out", M]
      }],
      /**
       * Caret Color
       * @see https://tailwindcss.com/docs/just-in-time-mode#caret-color-utilities
       */
      "caret-color": [{
        caret: [e]
      }],
      /**
       * Pointer Events
       * @see https://tailwindcss.com/docs/pointer-events
       */
      "pointer-events": [{
        "pointer-events": ["none", "auto"]
      }],
      /**
       * Resize
       * @see https://tailwindcss.com/docs/resize
       */
      resize: [{
        resize: ["none", "y", "x", ""]
      }],
      /**
       * Scroll Behavior
       * @see https://tailwindcss.com/docs/scroll-behavior
       */
      "scroll-behavior": [{
        scroll: ["auto", "smooth"]
      }],
      /**
       * Scroll Margin
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-m": [{
        "scroll-m": A()
      }],
      /**
       * Scroll Margin X
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mx": [{
        "scroll-mx": A()
      }],
      /**
       * Scroll Margin Y
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-my": [{
        "scroll-my": A()
      }],
      /**
       * Scroll Margin Start
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-ms": [{
        "scroll-ms": A()
      }],
      /**
       * Scroll Margin End
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-me": [{
        "scroll-me": A()
      }],
      /**
       * Scroll Margin Top
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mt": [{
        "scroll-mt": A()
      }],
      /**
       * Scroll Margin Right
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mr": [{
        "scroll-mr": A()
      }],
      /**
       * Scroll Margin Bottom
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-mb": [{
        "scroll-mb": A()
      }],
      /**
       * Scroll Margin Left
       * @see https://tailwindcss.com/docs/scroll-margin
       */
      "scroll-ml": [{
        "scroll-ml": A()
      }],
      /**
       * Scroll Padding
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-p": [{
        "scroll-p": A()
      }],
      /**
       * Scroll Padding X
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-px": [{
        "scroll-px": A()
      }],
      /**
       * Scroll Padding Y
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-py": [{
        "scroll-py": A()
      }],
      /**
       * Scroll Padding Start
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-ps": [{
        "scroll-ps": A()
      }],
      /**
       * Scroll Padding End
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pe": [{
        "scroll-pe": A()
      }],
      /**
       * Scroll Padding Top
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pt": [{
        "scroll-pt": A()
      }],
      /**
       * Scroll Padding Right
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pr": [{
        "scroll-pr": A()
      }],
      /**
       * Scroll Padding Bottom
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pb": [{
        "scroll-pb": A()
      }],
      /**
       * Scroll Padding Left
       * @see https://tailwindcss.com/docs/scroll-padding
       */
      "scroll-pl": [{
        "scroll-pl": A()
      }],
      /**
       * Scroll Snap Align
       * @see https://tailwindcss.com/docs/scroll-snap-align
       */
      "snap-align": [{
        snap: ["start", "end", "center", "align-none"]
      }],
      /**
       * Scroll Snap Stop
       * @see https://tailwindcss.com/docs/scroll-snap-stop
       */
      "snap-stop": [{
        snap: ["normal", "always"]
      }],
      /**
       * Scroll Snap Type
       * @see https://tailwindcss.com/docs/scroll-snap-type
       */
      "snap-type": [{
        snap: ["none", "x", "y", "both"]
      }],
      /**
       * Scroll Snap Type Strictness
       * @see https://tailwindcss.com/docs/scroll-snap-type
       */
      "snap-strictness": [{
        snap: ["mandatory", "proximity"]
      }],
      /**
       * Touch Action
       * @see https://tailwindcss.com/docs/touch-action
       */
      touch: [{
        touch: ["auto", "none", "manipulation"]
      }],
      /**
       * Touch Action X
       * @see https://tailwindcss.com/docs/touch-action
       */
      "touch-x": [{
        "touch-pan": ["x", "left", "right"]
      }],
      /**
       * Touch Action Y
       * @see https://tailwindcss.com/docs/touch-action
       */
      "touch-y": [{
        "touch-pan": ["y", "up", "down"]
      }],
      /**
       * Touch Action Pinch Zoom
       * @see https://tailwindcss.com/docs/touch-action
       */
      "touch-pz": ["touch-pinch-zoom"],
      /**
       * User Select
       * @see https://tailwindcss.com/docs/user-select
       */
      select: [{
        select: ["none", "text", "all", "auto"]
      }],
      /**
       * Will Change
       * @see https://tailwindcss.com/docs/will-change
       */
      "will-change": [{
        "will-change": ["auto", "scroll", "contents", "transform", M]
      }],
      // SVG
      /**
       * Fill
       * @see https://tailwindcss.com/docs/fill
       */
      fill: [{
        fill: [e, "none"]
      }],
      /**
       * Stroke Width
       * @see https://tailwindcss.com/docs/stroke-width
       */
      "stroke-w": [{
        stroke: [de, ge, ut]
      }],
      /**
       * Stroke
       * @see https://tailwindcss.com/docs/stroke
       */
      stroke: [{
        stroke: [e, "none"]
      }],
      // Accessibility
      /**
       * Screen Readers
       * @see https://tailwindcss.com/docs/screen-readers
       */
      sr: ["sr-only", "not-sr-only"],
      /**
       * Forced Color Adjust
       * @see https://tailwindcss.com/docs/forced-color-adjust
       */
      "forced-color-adjust": [{
        "forced-color-adjust": ["auto", "none"]
      }]
    },
    conflictingClassGroups: {
      overflow: ["overflow-x", "overflow-y"],
      overscroll: ["overscroll-x", "overscroll-y"],
      inset: ["inset-x", "inset-y", "start", "end", "top", "right", "bottom", "left"],
      "inset-x": ["right", "left"],
      "inset-y": ["top", "bottom"],
      flex: ["basis", "grow", "shrink"],
      gap: ["gap-x", "gap-y"],
      p: ["px", "py", "ps", "pe", "pt", "pr", "pb", "pl"],
      px: ["pr", "pl"],
      py: ["pt", "pb"],
      m: ["mx", "my", "ms", "me", "mt", "mr", "mb", "ml"],
      mx: ["mr", "ml"],
      my: ["mt", "mb"],
      size: ["w", "h"],
      "font-size": ["leading"],
      "fvn-normal": ["fvn-ordinal", "fvn-slashed-zero", "fvn-figure", "fvn-spacing", "fvn-fraction"],
      "fvn-ordinal": ["fvn-normal"],
      "fvn-slashed-zero": ["fvn-normal"],
      "fvn-figure": ["fvn-normal"],
      "fvn-spacing": ["fvn-normal"],
      "fvn-fraction": ["fvn-normal"],
      "line-clamp": ["display", "overflow"],
      rounded: ["rounded-s", "rounded-e", "rounded-t", "rounded-r", "rounded-b", "rounded-l", "rounded-ss", "rounded-se", "rounded-ee", "rounded-es", "rounded-tl", "rounded-tr", "rounded-br", "rounded-bl"],
      "rounded-s": ["rounded-ss", "rounded-es"],
      "rounded-e": ["rounded-se", "rounded-ee"],
      "rounded-t": ["rounded-tl", "rounded-tr"],
      "rounded-r": ["rounded-tr", "rounded-br"],
      "rounded-b": ["rounded-br", "rounded-bl"],
      "rounded-l": ["rounded-tl", "rounded-bl"],
      "border-spacing": ["border-spacing-x", "border-spacing-y"],
      "border-w": ["border-w-s", "border-w-e", "border-w-t", "border-w-r", "border-w-b", "border-w-l"],
      "border-w-x": ["border-w-r", "border-w-l"],
      "border-w-y": ["border-w-t", "border-w-b"],
      "border-color": ["border-color-s", "border-color-e", "border-color-t", "border-color-r", "border-color-b", "border-color-l"],
      "border-color-x": ["border-color-r", "border-color-l"],
      "border-color-y": ["border-color-t", "border-color-b"],
      "scroll-m": ["scroll-mx", "scroll-my", "scroll-ms", "scroll-me", "scroll-mt", "scroll-mr", "scroll-mb", "scroll-ml"],
      "scroll-mx": ["scroll-mr", "scroll-ml"],
      "scroll-my": ["scroll-mt", "scroll-mb"],
      "scroll-p": ["scroll-px", "scroll-py", "scroll-ps", "scroll-pe", "scroll-pt", "scroll-pr", "scroll-pb", "scroll-pl"],
      "scroll-px": ["scroll-pr", "scroll-pl"],
      "scroll-py": ["scroll-pt", "scroll-pb"],
      touch: ["touch-x", "touch-y", "touch-pz"],
      "touch-x": ["touch"],
      "touch-y": ["touch"],
      "touch-pz": ["touch"]
    },
    conflictingClassGroupModifiers: {
      "font-size": ["leading"]
    }
  };
}, Gn = /* @__PURE__ */ Rn(Kn);
function ae(...e) {
  return Gn(bn(e));
}
var Vn = /* @__PURE__ */ S('<pre class="my-2 rounded-lg bg-background p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap">'), Jn = /* @__PURE__ */ S("<span class=whitespace-pre-wrap>"), Zn = /* @__PURE__ */ S('<div class="message--user flex justify-end mb-3"><div class="max-w-[75%] bg-panel-2 px-4 py-2.5 text-foreground text-sm"style="border-radius:18px 18px 4px 18px"><div class="mt-1 text-[10px] text-subtle text-right">'), Xn = /* @__PURE__ */ S('<span class="inline-block w-1.5 h-4 bg-accent rounded-sm animate-pulse ml-0.5 align-text-bottom">'), Yn = /* @__PURE__ */ S('<div class="mt-1 text-xs text-danger border border-danger/30 rounded px-2 py-1">'), es = /* @__PURE__ */ S('<span class="ml-2 font-mono">'), ts = /* @__PURE__ */ S('<div class="message--assistant flex justify-start mb-3"><div class=max-w-[85%]><div class="mt-1 text-[10px] text-subtle">'), rs = /* @__PURE__ */ S('<div class="text-sm text-foreground mb-1">'), ns = /* @__PURE__ */ S('<div class="border-l-2 border-subtle pl-3 mb-2 text-sm text-muted italic">'), ss = /* @__PURE__ */ S('<div class="inline-block mb-1 mr-1 rounded bg-panel-2 px-2 py-0.5 font-mono text-xs text-muted">'), os = /* @__PURE__ */ S('<div class="message--toolResult mb-2 ml-4"><div><span class="text-subtle mr-1">⤶ <!>:'), is = /* @__PURE__ */ S('<div class="workflow-card mb-3 mx-1"><div class="rounded-lg border border-border bg-panel p-3 max-w-[85%]"><div class="flex items-center gap-2 mb-2"><span class="workflow-card__title text-sm font-medium text-foreground"></span><span></span></div><div class="text-xs text-subtle font-mono mb-2">Run: </div><div class="workflow-card__actions flex items-center gap-2 flex-wrap"><button class="rounded px-2 py-1 text-xs bg-accent/20 text-accent hover:bg-accent/30 transition-colors">Open run'), as = /* @__PURE__ */ S('<div class="flex items-center gap-1"><button class="rounded px-2 py-1 text-xs bg-success/20 text-success hover:bg-success/30 transition-colors">Approve</button><button class="rounded px-2 py-1 text-xs bg-danger/20 text-danger hover:bg-danger/30 transition-colors">Deny'), ls = /* @__PURE__ */ S('<div class="mention-box absolute bottom-full left-4 right-4 mb-1 rounded-lg border border-border bg-panel shadow-lg max-h-48 overflow-y-auto z-50">'), cs = /* @__PURE__ */ S('<button class="mention-item w-full text-left px-3 py-2 text-sm text-foreground hover:bg-panel-2 transition-colors flex items-center gap-2"><span></span><span class=truncate>'), us = /* @__PURE__ */ S('<span class="text-[11px] text-subtle font-mono truncate max-w-[180px]">'), ds = /* @__PURE__ */ S('<span class="text-[10px] text-accent font-mono bg-accent/10 rounded px-1.5 py-0.5">run:'), fs = /* @__PURE__ */ S('<div class="message--error mb-3 rounded-lg border border-danger/40 bg-danger/5 px-4 py-2 text-sm text-danger">'), hs = /* @__PURE__ */ S('<div class="max-w-2xl mx-auto"><div>'), ps = /* @__PURE__ */ S('<div class="chat-panel flex flex-col flex-1 min-h-0"><header class="flex items-center gap-2 px-4 h-11 shrink-0 border-b border-border bg-panel"><select id=session-select class="bg-panel-2 text-foreground text-xs rounded px-2 py-1 border border-border min-w-[140px] max-w-[220px] truncate"></select><button id=new-session class="w-6 h-6 rounded flex items-center justify-center text-muted hover:text-foreground hover:bg-panel-2 transition-colors text-sm"title="New session">+</button><div class=flex-1></div><button id=toggle-sidebar title="Toggle inspector (⌘I)">⌘I</button></header><div class="flex-1 overflow-y-auto min-h-0 px-4 py-4"></div><div class="shrink-0 px-4 pb-4 pt-1"><div class="relative max-w-2xl mx-auto"><div class="flex items-end gap-2 rounded-[22px] border border-border bg-panel p-2 shadow-lg"><textarea class="flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-subtle px-2 py-1.5 min-h-[3rem] max-h-[12rem] leading-relaxed focus:outline-none"placeholder="Ask anything, @ to add files, / for commands"rows=1></textarea><button>'), gs = /* @__PURE__ */ S("<option>"), bs = /* @__PURE__ */ S('<div class="flex items-center justify-center h-full"><span class="text-subtle text-lg">How can I help you today?');
function ms(e) {
  return typeof e.content == "string" ? e.content : e.content.filter((t) => t.type === "text").map((t) => t.text).join("");
}
function kr(e) {
  const t = e.split(/(```[\s\S]*?```)/g);
  return w(J, {
    each: t,
    children: (r) => r.startsWith("```") ? (() => {
      var n = Vn();
      return f(n, () => r.replace(/^```\w*\n?/, "").replace(/\n?```$/, "")), n;
    })() : (() => {
      var n = Jn();
      return f(n, r), n;
    })()
  });
}
function ws(e) {
  const t = Object.keys(e.arguments).slice(0, 2).join(", ");
  return `→ ${e.name}(${t})`;
}
function vs(e) {
  switch (e) {
    case "running":
      return "bg-accent/20 text-accent";
    case "waiting-approval":
      return "bg-warning/20 text-warning";
    case "finished":
      return "bg-success/20 text-success";
    case "failed":
    case "cancelled":
      return "bg-danger/20 text-danger";
    default:
      return "bg-panel-2 text-muted";
  }
}
const xs = (e) => (() => {
  var t = Zn(), r = t.firstChild, n = r.firstChild;
  return f(r, () => kr(ms(e.msg)), n), f(n, () => je(e.timestamp)), t;
})(), ys = (e) => (() => {
  var t = ts(), r = t.firstChild, n = r.firstChild;
  return f(r, w(J, {
    get each() {
      return e.msg.content;
    },
    children: (o) => o.type === "text" ? (() => {
      var s = rs();
      return f(s, () => kr(o.text)), s;
    })() : o.type === "thinking" ? (() => {
      var s = ns();
      return f(s, () => o.thinking), s;
    })() : o.type === "toolCall" ? (() => {
      var s = ss();
      return f(s, () => ws(o)), s;
    })() : null
  }), n), f(r, w(q, {
    get when() {
      return e.streaming;
    },
    get children() {
      return Xn();
    }
  }), n), f(r, w(q, {
    get when() {
      return e.msg.errorMessage;
    },
    get children() {
      var o = Yn();
      return f(o, () => e.msg.errorMessage), o;
    }
  }), n), f(n, () => je(e.msg.timestamp), null), f(n, w(q, {
    get when() {
      return e.msg.model;
    },
    get children() {
      var o = es();
      return f(o, () => e.msg.model), o;
    }
  }), null), t;
})(), $s = (e) => {
  const t = () => e.msg.content.filter((r) => r.type === "text").map((r) => r.text).join("");
  return (() => {
    var r = os(), n = r.firstChild, o = n.firstChild, s = o.firstChild, a = s.nextSibling;
    return a.nextSibling, f(o, () => e.msg.toolName, a), f(n, () => gn(t(), 200), null), T(() => ie(n, ae("rounded bg-panel px-3 py-1.5 font-mono text-xs max-w-[80%]", e.msg.isError ? "text-danger border border-danger/30" : "text-muted"))), r;
  })();
}, ks = (e) => {
  const t = async (n, o) => {
    try {
      await X().request.approveNode({
        runId: e.msg.runId,
        nodeId: n,
        iteration: o
      });
    } catch (s) {
      console.error("Approve failed:", s);
    }
  }, r = async (n, o) => {
    try {
      await X().request.denyNode({
        runId: e.msg.runId,
        nodeId: n,
        iteration: o
      });
    } catch (s) {
      console.error("Deny failed:", s);
    }
  };
  return (() => {
    var n = is(), o = n.firstChild, s = o.firstChild, a = s.firstChild, i = a.nextSibling, l = s.nextSibling;
    l.firstChild;
    var c = l.nextSibling, d = c.firstChild;
    return f(a, () => e.msg.workflowName), f(i, () => e.msg.status), f(l, () => e.msg.runId.slice(0, 8), null), d.$$click = () => ue(e.msg.runId), f(c, w(q, {
      get when() {
        return Le(() => !!e.msg.approvals)() && e.msg.approvals.length > 0;
      },
      get children() {
        return w(J, {
          get each() {
            return e.msg.approvals;
          },
          children: (u) => (() => {
            var h = as(), g = h.firstChild, m = g.nextSibling;
            return g.$$click = () => t(u.nodeId, u.iteration), m.$$click = () => r(u.nodeId, u.iteration), h;
          })()
        });
      }
    }), null), T(() => ie(i, ae("workflow-card__status rounded-full px-2 py-0.5 text-[10px] font-medium", vs(e.msg.status)))), n;
  })();
}, Ss = (e) => w(q, {
  get when() {
    return e.items.length > 0;
  },
  get children() {
    var t = ls();
    return f(t, w(J, {
      get each() {
        return e.items;
      },
      children: (r) => (() => {
        var n = cs(), o = n.firstChild, s = o.nextSibling;
        return n.$$mousedown = (a) => {
          a.preventDefault(), e.onSelect(r);
        }, f(o, () => r.kind === "workflow" ? "@wf" : "#run"), f(s, () => r.label), T(() => ie(o, ae("text-[10px] rounded px-1 py-0.5 font-mono", r.kind === "workflow" ? "bg-accent/20 text-accent" : "bg-warning/20 text-warning"))), n;
      })()
    })), t;
  }
}), _s = (e) => {
  const [t, r] = L(""), [n, o] = L({
    messages: [],
    isStreaming: !1,
    streamingMessage: null
  }), [s, a] = L([]);
  let i, l;
  $e(Pt(() => $.agent, (x) => {
    if (!x) return;
    const R = x.subscribe((F) => o(F));
    De(R);
  }));
  const c = Q(() => {
    const x = n(), R = [...x.messages];
    return x.streamingMessage && R.push(x.streamingMessage), R;
  }), d = () => n().isStreaming, u = () => n().error;
  $e(Pt(() => c().length, () => {
    queueMicrotask(() => i?.scrollIntoView({
      behavior: "smooth"
    }));
  }));
  const h = () => {
    if (!l) return;
    l.style.height = "auto";
    const x = 192;
    l.style.height = `${Math.min(l.scrollHeight, x)}px`;
  }, g = (x) => {
    r(x), h(), m(x);
  }, m = (x) => {
    const R = x.match(/@workflow\(([^)]*)$/);
    if (R) {
      const H = R[1].toLowerCase(), k = $.workflows.filter((v) => (v.name ?? v.path).toLowerCase().includes(H)).slice(0, 8).map((v) => ({
        label: v.name ?? v.path,
        value: `@workflow(${v.path})`,
        kind: "workflow"
      }));
      a(k);
      return;
    }
    const F = x.match(/#run\(([^)]*)$/);
    if (F) {
      const H = F[1].toLowerCase(), k = $.runs.filter((v) => v.runId.toLowerCase().includes(H) || v.workflowName?.toLowerCase().includes(H)).slice(0, 8).map((v) => ({
        label: `${v.workflowName ?? "run"} (${v.runId.slice(0, 8)})`,
        value: `#run(${v.runId})`,
        kind: "run"
      }));
      a(k);
      return;
    }
    a([]);
  }, p = (x) => {
    const R = t(), F = x.kind === "workflow" ? /@workflow\([^)]*$/ : /#run\([^)]*$/, H = R.replace(F, x.value);
    r(H), a([]), l?.focus();
  }, b = async () => {
    if (d()) {
      $.agent?.abort();
      return;
    }
    const x = t().trim();
    !x || !$.agent || (r(""), l && (l.style.height = "auto"), await $.agent.send(x));
  }, _ = (x) => {
    x.key === "Enter" && !x.shiftKey && (x.preventDefault(), b());
  }, y = () => {
    E("inspectorOpen", (x) => !x);
  }, I = (x) => {
    x !== $.sessionId && Pr(x);
  };
  return (() => {
    var x = ps(), R = x.firstChild, F = R.firstChild, H = F.nextSibling, k = H.nextSibling, v = k.nextSibling, O = R.nextSibling, C = O.nextSibling, A = C.firstChild, D = A.firstChild, N = D.firstChild, Z = N.nextSibling;
    F.addEventListener("change", (P) => I(P.currentTarget.value)), f(F, w(J, {
      get each() {
        return $.sessions;
      },
      children: (P) => (() => {
        var U = gs();
        return f(U, () => P.title || P.sessionId.slice(0, 10)), T(() => U.value = P.sessionId), U;
      })()
    })), H.$$click = () => Tr(), f(R, w(q, {
      get when() {
        return $.workspaceRoot;
      },
      get children() {
        var P = us();
        return f(P, () => br($.workspaceRoot)), T(() => K(P, "title", $.workspaceRoot)), P;
      }
    }), v), f(R, w(q, {
      get when() {
        return $.contextRunId;
      },
      get children() {
        var P = ds();
        return P.firstChild, f(P, () => $.contextRunId.slice(0, 8), null), P;
      }
    }), v), v.$$click = y, f(O, w(q, {
      get when() {
        return c().length > 0;
      },
      get fallback() {
        return bs();
      },
      get children() {
        var P = hs(), U = P.firstChild;
        f(P, w(J, {
          get each() {
            return c();
          },
          children: (j, ee) => {
            const _e = () => n().streamingMessage !== null && ee() === c().length - 1 && j.role === "assistant";
            return [w(q, {
              get when() {
                return j.role === "user";
              },
              get children() {
                return w(xs, {
                  msg: j,
                  get timestamp() {
                    return j.timestamp;
                  }
                });
              }
            }), w(q, {
              get when() {
                return j.role === "assistant";
              },
              get children() {
                return w(ys, {
                  msg: j,
                  get streaming() {
                    return _e();
                  }
                });
              }
            }), w(q, {
              get when() {
                return j.role === "toolResult";
              },
              get children() {
                return w($s, {
                  msg: j
                });
              }
            }), w(q, {
              get when() {
                return j.role === "workflow";
              },
              get children() {
                return w(ks, {
                  msg: j
                });
              }
            })];
          }
        }), U), f(P, w(q, {
          get when() {
            return u();
          },
          get children() {
            var j = fs();
            return f(j, u), j;
          }
        }), U);
        var Y = i;
        return typeof Y == "function" ? Mt(Y, U) : i = U, P;
      }
    })), f(A, w(Ss, {
      get items() {
        return s();
      },
      onSelect: p
    }), D), N.$$keydown = _, N.$$input = (P) => g(P.currentTarget.value);
    var ne = l;
    return typeof ne == "function" ? Mt(ne, N) : l = N, Z.$$click = b, f(Z, () => d() ? "■" : "Send"), T((P) => {
      var U = ae("w-7 h-7 rounded flex items-center justify-center text-xs transition-colors", $.inspectorOpen ? "bg-accent/20 text-accent" : "text-muted hover:text-foreground hover:bg-panel-2"), Y = d(), j = ae("w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors text-sm font-medium", d() ? "bg-danger text-white hover:bg-danger/80" : t().trim() ? "bg-accent text-white hover:bg-accent/80" : "bg-panel-2 text-subtle cursor-default"), ee = d() ? "Stop" : "Send";
      return U !== P.e && ie(v, P.e = U), Y !== P.t && (N.disabled = P.t = Y), j !== P.a && ie(Z, P.a = j), ee !== P.o && K(Z, "title", P.o = ee), P;
    }, {
      e: void 0,
      t: void 0,
      a: void 0,
      o: void 0
    }), T(() => F.value = $.sessionId ?? ""), T(() => N.value = t()), x;
  })();
};
pe(["click", "mousedown", "input", "keydown"]);
var Cs = /* @__PURE__ */ S('<div class="flex flex-col flex-1 min-h-0 overflow-hidden"><div class="px-4 py-3 border-b border-border"><h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Runs</h3></div><div class="flex-1 overflow-y-auto">'), Is = /* @__PURE__ */ S('<div class="empty text-muted text-xs uppercase tracking-wide text-center py-8">No runs found.'), As = /* @__PURE__ */ S("<span>• Active: <span class=font-mono>"), Rs = /* @__PURE__ */ S('<span class="bg-accent text-[#07080A] text-[9px] px-1.5 rounded-full font-semibold"> approvals'), Os = /* @__PURE__ */ S('<button class="px-2 py-1 rounded border border-border bg-panel-2 text-muted text-[11px] uppercase tracking-wide cursor-pointer hover:text-foreground"data-action=cancel>Cancel'), Ps = /* @__PURE__ */ S('<button class="px-2 py-1 rounded border border-border bg-panel-2 text-muted text-[11px] uppercase tracking-wide cursor-pointer hover:text-foreground"data-action=resume>Resume'), Ts = /* @__PURE__ */ S('<div tabindex=0 role=listitem><div></div><div class="flex-1 min-w-0"><div class="font-semibold text-sm truncate"></div><div class="text-[10px] text-muted flex flex-wrap gap-1 mt-0.5"><span class=font-mono></span><span>• </span><span>• </span></div></div><div class="flex gap-1 flex-shrink-0"><button class="px-2 py-1 rounded border border-border bg-panel-2 text-muted text-[11px] uppercase tracking-wide cursor-pointer hover:text-foreground"data-action=open>Open</button><button class="px-2 py-1 rounded border border-border bg-panel-2 text-muted text-[11px] uppercase tracking-wide cursor-pointer hover:text-foreground"data-action=copy>Copy ID');
function Es(e) {
  switch (e) {
    case "running":
      return "bg-accent";
    case "finished":
      return "bg-success";
    case "failed":
      return "bg-danger";
    case "waiting-approval":
      return "bg-warning";
    case "cancelled":
      return "bg-subtle";
    default:
      return "bg-subtle";
  }
}
const Ms = () => (() => {
  var e = Cs(), t = e.firstChild, r = t.nextSibling;
  return f(r, w(q, {
    get when() {
      return $.runs.length > 0;
    },
    get fallback() {
      return Is();
    },
    get children() {
      return w(J, {
        get each() {
          return $.runs;
        },
        children: (n) => (() => {
          var o = Ts(), s = o.firstChild, a = s.nextSibling, i = a.firstChild, l = i.nextSibling, c = l.firstChild, d = c.nextSibling;
          d.firstChild;
          var u = d.nextSibling;
          u.firstChild;
          var h = a.nextSibling, g = h.firstChild, m = g.nextSibling;
          return o.$$keydown = (p) => {
            (p.key === "Enter" || p.key === " ") && (p.preventDefault(), ue(n.runId));
          }, o.$$click = () => ue(n.runId), f(i, () => n.workflowName), f(c, () => n.runId.slice(0, 6)), f(d, () => je(n.startedAtMs), null), f(u, () => gr(n.startedAtMs, n.finishedAtMs ?? null), null), f(l, w(q, {
            get when() {
              return n.activeNodes?.length;
            },
            get children() {
              var p = As(), b = p.firstChild, _ = b.nextSibling;
              return f(_, () => n.activeNodes[0]), p;
            }
          }), null), f(l, w(q, {
            get when() {
              return (n.waitingApprovals ?? 0) > 0;
            },
            get children() {
              var p = Rs(), b = p.firstChild;
              return f(p, () => n.waitingApprovals, b), p;
            }
          }), null), h.$$click = (p) => p.stopPropagation(), g.$$click = () => ue(n.runId), f(h, w(q, {
            get when() {
              return n.status === "running" || n.status === "waiting-approval";
            },
            get children() {
              var p = Os();
              return p.$$click = async () => {
                await X().request.cancelRun({
                  runId: n.runId
                }), await ce(), se("info", "Run cancelled");
              }, p;
            }
          }), m), f(h, w(q, {
            get when() {
              return n.status === "waiting-approval";
            },
            get children() {
              var p = Ps();
              return p.$$click = () => X().request.resumeRun({
                runId: n.runId
              }), p;
            }
          }), m), m.$$click = () => {
            navigator.clipboard?.writeText(n.runId), se("info", "Run ID copied");
          }, T((p) => {
            var b = ae("run-row flex items-center gap-3 px-4 py-3 border-b border-border cursor-pointer hover:bg-panel-2 transition-colors", `status-${n.status}`), _ = ae("w-2 h-2 rounded-full flex-shrink-0", Es(n.status));
            return b !== p.e && ie(o, p.e = b), _ !== p.t && ie(s, p.t = _), p;
          }, {
            e: void 0,
            t: void 0
          }), o;
        })()
      });
    }
  })), e;
})();
pe(["click", "keydown"]);
var qs = /* @__PURE__ */ S('<div class="flex flex-col flex-1 min-h-0 overflow-hidden"><div class="px-4 py-3 border-b border-border"><h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Workflows</h3></div><div class="flex-1 overflow-y-auto">'), Fs = /* @__PURE__ */ S('<div class="empty text-muted text-xs uppercase tracking-wide text-center py-8">No workflows found. Open a workspace to scan for .tsx workflows.'), Ds = /* @__PURE__ */ S('<div class="workflow-row flex items-center justify-between px-4 py-3 border-b border-border hover:bg-panel-2 transition-colors"><div><div class="workflow-row__title font-semibold text-sm"></div><div class="text-[10px] text-muted mt-0.5"></div></div><button class="px-3 py-1.5 rounded bg-accent text-white text-[11px] font-semibold uppercase tracking-wide cursor-pointer hover:bg-accent-hover">Run');
const Ns = (e) => (() => {
  var t = qs(), r = t.firstChild, n = r.nextSibling;
  return f(n, w(q, {
    get when() {
      return $.workflows.length > 0;
    },
    get fallback() {
      return Fs();
    },
    get children() {
      return w(J, {
        get each() {
          return $.workflows;
        },
        children: (o) => (() => {
          var s = Ds(), a = s.firstChild, i = a.firstChild, l = i.nextSibling, c = a.nextSibling;
          return f(i, () => o.name ?? o.path), f(l, () => o.path), c.$$click = () => e.onRunWorkflow?.(o.path), s;
        })()
      });
    }
  })), t;
})();
pe(["click"]);
var Ls = /* @__PURE__ */ S("<option>"), js = /* @__PURE__ */ S('<nav class="flex flex-col bg-[#07080A] border-r border-border w-14 flex-shrink-0 overflow-hidden py-2 z-10"><div class="flex items-center gap-2 px-3 pb-3 border-b border-border mb-2"><span class="text-lg text-accent flex-shrink-0 w-8 text-center">◆</span><span class="text-xs font-semibold uppercase tracking-widest text-muted whitespace-nowrap overflow-hidden">Smithers</span></div><div class="px-2 mb-2"><select id=workspace-select class="w-full bg-transparent border border-border text-foreground text-xs rounded-md px-1 py-1 cursor-pointer focus:border-accent focus:outline-none truncate"><option value>No workspace</option></select></div><div class="flex flex-col gap-0.5 px-2"></div><div class="mt-auto pt-2 border-t border-border px-2"><div class="text-[9px] text-subtle text-center py-1 font-mono">v0.1.0'), Ws = /* @__PURE__ */ S('<span class="absolute top-1 right-1 bg-accent text-[#07080A] text-[9px] px-1 rounded-full font-semibold font-mono min-w-[14px] text-center leading-[14px]">'), zs = /* @__PURE__ */ S('<button class="flex items-center gap-2.5 p-2 border-none bg-transparent text-muted cursor-pointer rounded-md text-[11px] font-medium uppercase tracking-wide whitespace-nowrap transition-colors duration-100 relative"><span class="text-base w-6 text-center flex-shrink-0"></span><span class="overflow-hidden text-ellipsis">');
const Qs = [{
  view: "chat",
  icon: "💬",
  label: "Chat",
  id: "tab-chat"
}, {
  view: "runs",
  icon: "▶",
  label: "Runs",
  id: "tab-runs"
}, {
  view: "workflows",
  icon: "⚡",
  label: "Workflows",
  id: "tab-workflows"
}, {
  view: "settings",
  icon: "⚙",
  label: "Settings"
}], Hs = () => {
  const e = Q(() => $.runs.reduce((t, r) => t + (r.waitingApprovals ?? 0), 0));
  return (() => {
    var t = js(), r = t.firstChild, n = r.nextSibling, o = n.firstChild, s = o.firstChild, a = n.nextSibling;
    return o.addEventListener("change", (i) => {
      i.currentTarget.value, $.workspaceRoot;
    }), f(o, w(q, {
      get when() {
        return $.workspaceRoot;
      },
      get children() {
        var i = Ls();
        return f(i, () => br($.workspaceRoot, 20)), T(() => i.value = $.workspaceRoot), i;
      }
    }), s), f(a, w(J, {
      each: Qs,
      children: (i) => (() => {
        var l = zs(), c = l.firstChild, d = c.nextSibling;
        return l.$$click = () => E("currentView", i.view), f(c, () => i.icon), f(d, () => i.label), f(l, w(q, {
          get when() {
            return Le(() => i.view === "runs")() && e() > 0;
          },
          get children() {
            var u = Ws();
            return f(u, e), u;
          }
        }), null), T((u) => {
          var h = i.id, g = {
            "bg-accent/15 text-accent": $.currentView === i.view,
            "hover:bg-panel-2 hover:text-foreground": $.currentView !== i.view
          };
          return h !== u.e && K(l, "id", u.e = h), u.t = on(l, g, u.t), u;
        }, {
          e: void 0,
          t: void 0
        }), l;
      })()
    })), T(() => o.value = $.workspaceRoot ?? ""), t;
  })();
};
pe(["click"]);
var Bs = /* @__PURE__ */ S('<div id=sidebar-collapsed class="absolute right-0 top-1/2 -translate-y-1/2 z-10"><button id=sidebar-open class="bg-panel border border-border rounded-l px-1 py-2 text-xs text-muted hover:text-foreground cursor-pointer">◀'), Us = /* @__PURE__ */ S('<div class="relative flex-shrink-0"><aside id=sidebar aria-label=Inspector><div class="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0"><span class="text-xs font-semibold uppercase tracking-wide text-muted">Inspector</span><div class="flex gap-1"><button class="text-muted hover:text-foreground bg-transparent border border-border rounded px-1.5 py-0.5 text-xs cursor-pointer"></button><button class="text-muted hover:text-foreground bg-transparent border border-border rounded px-1.5 py-0.5 text-xs cursor-pointer">✕</button></div></div><div class="flex-1 overflow-y-auto">'), Ks = /* @__PURE__ */ S('<div class="text-muted text-xs uppercase tracking-wide text-center py-8">Select a run to inspect'), Gs = /* @__PURE__ */ S('<button class="px-2 py-1 rounded border border-border bg-panel-2 text-muted text-[11px] uppercase tracking-wide cursor-pointer hover:text-foreground">Cancel'), Vs = /* @__PURE__ */ S('<button class="px-2 py-1 rounded border border-border bg-panel-2 text-muted text-[11px] uppercase tracking-wide cursor-pointer hover:text-foreground">Resume'), Js = /* @__PURE__ */ S('<div class="p-3 border-b border-border bg-warning/5">'), Zs = /* @__PURE__ */ S('<div class="flex flex-col"><div class="run-header__meta p-3 border-b border-border"><div class="font-semibold text-sm"></div><div class="text-[10px] text-muted mt-1 flex flex-wrap gap-1"><span class="mono font-mono"></span><span>• </span><span>• </span><span>• </span></div><div class="flex gap-1.5 mt-2"></div></div><div class="flex border-b border-border"></div><div class="flex-1 p-3 overflow-y-auto">'), Xs = /* @__PURE__ */ S('<div class="approval-card py-1.5"><div class="approval-card__title text-xs font-semibold uppercase tracking-wide text-warning mb-2">Approval Required</div><div class="flex items-center justify-between"><div><span class="font-mono text-xs"></span><span class="text-[10px] text-muted ml-1">(iter <!>)</span></div><div class="flex gap-1"><button class="btn btn-primary px-2 py-0.5 rounded bg-accent text-white text-[10px] font-semibold uppercase cursor-pointer">Approve</button><button class="btn btn-danger px-2 py-0.5 rounded bg-danger text-white text-[10px] font-semibold uppercase cursor-pointer">Deny'), Sr = /* @__PURE__ */ S("<button>"), Ys = /* @__PURE__ */ S('<div><div class="flex gap-1 mb-2"><button class="px-2 py-0.5 text-xs border border-border rounded bg-panel-2 text-muted cursor-pointer hover:text-foreground"data-graph-action=zoom-in>+</button><button class="px-2 py-0.5 text-xs border border-border rounded bg-panel-2 text-muted cursor-pointer hover:text-foreground"data-graph-action=zoom-out>−</button><button class="px-2 py-0.5 text-xs border border-border rounded bg-panel-2 text-muted cursor-pointer hover:text-foreground"data-graph-action=fit>Fit'), eo = /* @__PURE__ */ S('<div class="text-muted text-xs uppercase">No frame data yet.'), to = /* @__PURE__ */ S('<div class="graph-canvas overflow-auto"><svg class=block>'), ro = /* @__PURE__ */ S("<svg><line stroke=#1E2736 stroke-width=2></svg>", !1, !0, !1), no = /* @__PURE__ */ S("<svg><g class=cursor-pointer><rect rx=10 ry=10 width=140 height=48></rect><text fill=#e9eaf0 font-size=12></svg>", !1, !0, !1), so = /* @__PURE__ */ S('<div class="node-drawer__section mb-2"><div class="node-drawer__label text-[10px] text-muted uppercase tracking-wide mb-1">Output</div><pre class="text-xs font-mono text-muted overflow-auto">'), oo = /* @__PURE__ */ S('<div class="node-drawer mt-3 border-t border-border pt-3"><div class="node-drawer__title text-sm font-semibold mb-2"></div><div class="node-drawer__section mb-2"><div class="node-drawer__label text-[10px] text-muted uppercase tracking-wide mb-1">State</div><div class=text-xs></div></div><div class="node-drawer__actions flex gap-1 mt-2"><button class="px-2 py-0.5 text-[10px] border border-border rounded bg-panel-2 text-muted cursor-pointer hover:text-foreground"data-copy=output>Copy Output'), io = /* @__PURE__ */ S('<div class="flex flex-col gap-1">'), ao = /* @__PURE__ */ S('<div class="text-muted text-xs uppercase">No events.'), lo = /* @__PURE__ */ S('<span class="text-muted font-mono">'), co = /* @__PURE__ */ S('<div class="timeline-row flex gap-3 text-xs py-1"><span class="text-muted font-mono flex-shrink-0"></span><span class=text-foreground>'), uo = /* @__PURE__ */ S('<div class="mb-3 border border-border rounded bg-background p-2"><div class="text-[10px] text-muted uppercase tracking-wide mb-1">Agent Output</div><pre class="text-xs font-mono text-foreground overflow-auto whitespace-pre-wrap max-h-[400px]">'), fo = /* @__PURE__ */ S('<div><div class="flex gap-1 mb-2 items-center flex-wrap"><input id=logs-search class="bg-background border border-border text-foreground text-xs rounded px-2 py-1 flex-1 min-w-[100px] focus:border-accent focus:outline-none"placeholder="Search logs…"><button>Output</button><button id=logs-export class="px-2 py-0.5 text-[10px] border border-border rounded bg-panel-2 text-muted cursor-pointer hover:text-foreground">Export</button><button id=logs-copy class="px-2 py-0.5 text-[10px] border border-border rounded bg-panel-2 text-muted cursor-pointer hover:text-foreground">Copy</button></div><pre class="logs text-xs font-mono text-muted overflow-auto whitespace-pre-wrap">'), ho = /* @__PURE__ */ S('<div class="text-muted text-xs uppercase">No outputs.'), po = /* @__PURE__ */ S('<div class="output-table mb-3"><div class="output-table__title text-xs font-semibold mb-1"> (<!>)</div><pre class="text-xs font-mono text-muted overflow-auto">'), go = /* @__PURE__ */ S('<div class="text-muted text-xs uppercase">No attempts.'), bo = /* @__PURE__ */ S('<div class="text-[10px] text-danger mt-0.5">Error: '), mo = /* @__PURE__ */ S('<div class="attempt-row flex justify-between items-start py-1.5 border-b border-border last:border-0"><div><div class="font-mono text-xs"></div><div class="text-[10px] text-muted">iter <!> - attempt </div></div><div class="text-[10px] text-muted">');
const wo = [{
  key: "graph",
  label: "Graph"
}, {
  key: "timeline",
  label: "Timeline"
}, {
  key: "logs",
  label: "Logs"
}, {
  key: "outputs",
  label: "Outputs"
}, {
  key: "attempts",
  label: "Attempts"
}], vo = () => {
  const e = Q(() => {
    const o = $.selectedRunId;
    return o ? $.runDetails[o] : void 0;
  }), t = Q(() => {
    const o = e();
    return o ? o.nodes.filter((s) => s.state === "waiting-approval") : [];
  }), r = async (o, s) => {
    const a = $.selectedRunId;
    a && (await X().request.approveNode({
      runId: a,
      nodeId: o,
      iteration: s
    }), await ce(), await ue(a));
  }, n = async (o, s) => {
    const a = $.selectedRunId;
    a && (await X().request.denyNode({
      runId: a,
      nodeId: o,
      iteration: s
    }), await ce(), await ue(a));
  };
  return (() => {
    var o = Us(), s = o.firstChild, a = s.firstChild, i = a.firstChild, l = i.nextSibling, c = l.firstChild, d = c.nextSibling, u = a.nextSibling;
    return c.$$click = () => E("inspectorExpanded", (h) => !h), f(c, () => $.inspectorExpanded ? "⤡" : "⤢"), d.$$click = () => E({
      inspectorOpen: !1,
      inspectorExpanded: !1
    }), f(u, w(q, {
      get when() {
        return e();
      },
      get fallback() {
        return Ks();
      },
      children: (h) => (() => {
        var g = Zs(), m = g.firstChild, p = m.firstChild, b = p.nextSibling, _ = b.firstChild, y = _.nextSibling;
        y.firstChild;
        var I = y.nextSibling;
        I.firstChild;
        var x = I.nextSibling;
        x.firstChild;
        var R = b.nextSibling, F = m.nextSibling, H = F.nextSibling;
        return f(p, () => h().run.workflowName), f(_, () => h().run.runId), f(y, () => h().run.status, null), f(I, () => je(h().run.startedAtMs), null), f(x, () => gr(h().run.startedAtMs, h().run.finishedAtMs ?? null), null), f(R, w(q, {
          get when() {
            return h().run.status === "running" || h().run.status === "waiting-approval";
          },
          get children() {
            var k = Gs();
            return k.$$click = async () => {
              $.selectedRunId && (await X().request.cancelRun({
                runId: $.selectedRunId
              }), await ce(), await ue($.selectedRunId), se("info", "Run cancelled"));
            }, k;
          }
        }), null), f(R, w(q, {
          get when() {
            return h().run.status === "failed" || h().run.status === "cancelled";
          },
          get children() {
            var k = Vs();
            return k.$$click = async () => {
              $.selectedRunId && (await X().request.resumeRun({
                runId: $.selectedRunId
              }), await ce(), await ue($.selectedRunId), se("info", "Run resumed"));
            }, k;
          }
        }), null), f(g, w(q, {
          get when() {
            return t().length > 0;
          },
          get children() {
            var k = Js();
            return f(k, w(J, {
              get each() {
                return t();
              },
              children: (v) => (() => {
                var O = Xs(), C = O.firstChild, A = C.nextSibling, D = A.firstChild, N = D.firstChild, Z = N.nextSibling, ne = Z.firstChild, P = ne.nextSibling;
                P.nextSibling;
                var U = D.nextSibling, Y = U.firstChild, j = Y.nextSibling;
                return f(N, () => v.nodeId), f(Z, () => v.iteration, P), Y.$$click = () => r(v.nodeId, v.iteration), j.$$click = () => n(v.nodeId, v.iteration), O;
              })()
            })), k;
          }
        }), F), f(F, w(J, {
          each: wo,
          children: (k) => (() => {
            var v = Sr();
            return v.$$click = () => E("activeTab", k.key), f(v, () => k.label), T((O) => {
              var C = ae("run-tab px-3 py-2 text-[11px] uppercase tracking-wide font-medium cursor-pointer bg-transparent border-none transition-colors", $.activeTab === k.key ? "text-accent border-b-2 border-b-accent" : "text-muted hover:text-foreground"), A = k.key;
              return C !== O.e && ie(v, O.e = C), A !== O.t && K(v, "data-tab", O.t = A), O;
            }, {
              e: void 0,
              t: void 0
            }), v;
          })()
        })), f(H, w(rn, {
          get children() {
            return [w(Ce, {
              get when() {
                return $.activeTab === "graph";
              },
              get children() {
                return w(xo, {
                  get runId() {
                    return $.selectedRunId;
                  }
                });
              }
            }), w(Ce, {
              get when() {
                return $.activeTab === "timeline";
              },
              get children() {
                return w(yo, {
                  get runId() {
                    return $.selectedRunId;
                  }
                });
              }
            }), w(Ce, {
              get when() {
                return $.activeTab === "logs";
              },
              get children() {
                return w($o, {
                  get runId() {
                    return $.selectedRunId;
                  }
                });
              }
            }), w(Ce, {
              get when() {
                return $.activeTab === "outputs";
              },
              get children() {
                return w(ko, {
                  get runId() {
                    return $.selectedRunId;
                  }
                });
              }
            }), w(Ce, {
              get when() {
                return $.activeTab === "attempts";
              },
              get children() {
                return w(So, {
                  get runId() {
                    return $.selectedRunId;
                  }
                });
              }
            })];
          }
        })), g;
      })()
    })), f(o, w(q, {
      get when() {
        return !$.inspectorOpen;
      },
      get children() {
        var h = Bs(), g = h.firstChild;
        return g.$$click = () => E("inspectorOpen", !0), h;
      }
    }), null), T((h) => {
      var g = $.inspectorOpen ? $.inspectorExpanded ? "calc(100% - 56px)" : "380px" : "0px", m = ae("border-l border-border bg-panel overflow-hidden flex flex-col h-full w-full transition-all duration-300", !$.inspectorOpen && "border-l-0 sidebar--closed"), p = !$.inspectorOpen;
      return g !== h.e && Pe(o, "width", h.e = g), m !== h.t && ie(s, h.t = m), p !== h.a && K(s, "aria-hidden", h.a = p), h;
    }, {
      e: void 0,
      t: void 0,
      a: void 0
    }), o;
  })();
};
function xo(e) {
  const t = Q(() => $.frames[e.runId]), [r, n] = L(null), o = Q(() => {
    const l = r();
    if (!l) return null;
    const c = t();
    return c ? c.graph.nodes.find((u) => u.id === l) ?? null : null;
  }), s = Q(() => {
    const l = r();
    if (!l) return;
    const c = $.outputs[e.runId];
    if (c)
      for (const d of c.tables) {
        const u = d.rows.find((h) => h.nodeId === l || h.node_id === l);
        if (u) return u;
      }
  }), a = () => $.graphZoom, i = () => `scale(${a()})`;
  return (() => {
    var l = Ys(), c = l.firstChild, d = c.firstChild, u = d.nextSibling, h = u.nextSibling;
    return d.$$click = () => E("graphZoom", (g) => g * 1.2), u.$$click = () => E("graphZoom", (g) => g / 1.2), h.$$click = () => E("graphZoom", 1), f(l, w(q, {
      get when() {
        return t();
      },
      get fallback() {
        return eo();
      },
      children: (g) => {
        const m = () => g().graph.nodes, p = () => g().graph.edges;
        return (() => {
          var b = to(), _ = b.firstChild;
          return f(_, w(J, {
            get each() {
              return p();
            },
            children: (y) => {
              const I = () => m().findIndex((v) => v.id === y.from), x = () => m().findIndex((v) => v.id === y.to), R = () => m()[I()], F = () => m()[x()], H = () => R()?.kind === "Workflow" ? 0 : R()?.kind === "Task" ? 2 : 1, k = () => F()?.kind === "Workflow" ? 0 : F()?.kind === "Task" ? 2 : 1;
              return w(q, {
                get when() {
                  return Le(() => !!R())() && F();
                },
                get children() {
                  var v = ro();
                  return T((O) => {
                    var C = H() * 180 + 180, A = I() * 90 + 64, D = k() * 180 + 40, N = x() * 90 + 64;
                    return C !== O.e && K(v, "x1", O.e = C), A !== O.t && K(v, "y1", O.t = A), D !== O.a && K(v, "x2", O.a = D), N !== O.o && K(v, "y2", O.o = N), O;
                  }, {
                    e: void 0,
                    t: void 0,
                    a: void 0,
                    o: void 0
                  }), v;
                }
              });
            }
          }), null), f(_, w(J, {
            get each() {
              return m();
            },
            children: (y, I) => {
              const x = () => y.kind === "Workflow" ? 0 : y.kind === "Task" ? 2 : 1, R = () => x() * 180 + 40, F = () => I() * 90 + 40, H = () => {
                switch (y.state) {
                  case "in-progress":
                    return {
                      bg: "#0D1530",
                      stroke: "#4C7DFF"
                    };
                  case "finished":
                    return {
                      bg: "#0A1F1A",
                      stroke: "#3DDC97"
                    };
                  case "failed":
                    return {
                      bg: "#1E0A12",
                      stroke: "#FF3B5C"
                    };
                  case "waiting-approval":
                    return {
                      bg: "#1A1508",
                      stroke: "#F2A43A"
                    };
                  default:
                    return {
                      bg: "#10141A",
                      stroke: "#2C3A4E"
                    };
                }
              };
              return (() => {
                var k = no(), v = k.firstChild, O = v.nextSibling;
                return k.$$click = () => n(y.id), f(O, () => y.label), T((C) => {
                  var A = y.id, D = R(), N = F(), Z = H().bg, ne = H().stroke, P = R() + 12, U = F() + 28;
                  return A !== C.e && K(k, "data-node-id", C.e = A), D !== C.t && K(v, "x", C.t = D), N !== C.a && K(v, "y", C.a = N), Z !== C.o && K(v, "fill", C.o = Z), ne !== C.i && K(v, "stroke", C.i = ne), P !== C.n && K(O, "x", C.n = P), U !== C.s && K(O, "y", C.s = U), C;
                }, {
                  e: void 0,
                  t: void 0,
                  a: void 0,
                  o: void 0,
                  i: void 0,
                  n: void 0,
                  s: void 0
                }), k;
              })();
            }
          }), null), T((y) => {
            var I = i(), x = Math.max(600, m().length * 180), R = Math.max(400, m().length * 90);
            return I !== y.e && Pe(b, "transform", y.e = I), x !== y.t && K(_, "width", y.t = x), R !== y.a && K(_, "height", y.a = R), y;
          }, {
            e: void 0,
            t: void 0,
            a: void 0
          }), b;
        })();
      }
    }), null), f(l, w(q, {
      get when() {
        return o();
      },
      children: (g) => (() => {
        var m = oo(), p = m.firstChild, b = p.nextSibling, _ = b.firstChild, y = _.nextSibling, I = b.nextSibling, x = I.firstChild;
        return f(p, () => g().label), f(y, () => g().state), f(m, w(q, {
          get when() {
            return s() !== void 0;
          },
          get children() {
            var R = so(), F = R.firstChild, H = F.nextSibling;
            return f(H, () => JSON.stringify(s(), null, 2)), R;
          }
        }), I), x.$$click = () => {
          navigator.clipboard?.writeText(JSON.stringify(s() ?? "", null, 2)), se("info", "Output copied");
        }, m;
      })()
    }), null), l;
  })();
}
function yo(e) {
  const t = Q(() => $.runEvents[e.runId] ?? []), r = Q(() => t().filter((n) => n.type !== "NodeOutput"));
  return (() => {
    var n = io();
    return f(n, w(J, {
      get each() {
        return r();
      },
      get fallback() {
        return ao();
      },
      children: (o) => (() => {
        var s = co(), a = s.firstChild, i = a.nextSibling;
        return f(a, () => je(o.timestampMs)), f(i, () => o.type), f(s, w(q, {
          get when() {
            return o.nodeId;
          },
          get children() {
            var l = lo();
            return f(l, () => o.nodeId), l;
          }
        }), null), s;
      })()
    })), n;
  })();
}
function $o(e) {
  const [t, r] = L(""), [n, o] = L(!0), [s, a] = L(/* @__PURE__ */ new Set(["run", "node", "approval", "revert"])), i = Q(() => $.runEvents[e.runId] ?? []), l = Q(() => {
    const h = [];
    for (const g of i())
      g.type === "NodeOutput" && h.push(g.text);
    return h.join("");
  }), c = Q(() => {
    let h = i();
    const g = t().toLowerCase();
    g && (h = h.filter((p) => JSON.stringify(p).toLowerCase().includes(g)));
    const m = s();
    return h = h.filter((p) => {
      const b = (p.type ?? "").toLowerCase();
      return !(b === "nodeoutput" || b.startsWith("run") && !m.has("run") || b.startsWith("node") && !m.has("node") || b.startsWith("approval") && !m.has("approval") || b.startsWith("revert") && !m.has("revert"));
    }), h;
  }), d = (h) => {
    a((g) => {
      const m = new Set(g);
      return m.has(h) ? m.delete(h) : m.add(h), m;
    });
  }, u = () => {
    const h = c().map((b) => JSON.stringify(b)).join(`
`), g = new Blob([h], {
      type: "application/x-ndjson"
    }), m = URL.createObjectURL(g), p = document.createElement("a");
    p.href = m, p.download = `${e.runId}-logs.jsonl`, p.click(), URL.revokeObjectURL(m);
  };
  return (() => {
    var h = fo(), g = h.firstChild, m = g.firstChild, p = m.nextSibling, b = p.nextSibling, _ = b.nextSibling, y = g.nextSibling;
    return m.$$input = (I) => r(I.currentTarget.value), p.$$click = () => o((I) => !I), f(g, () => ["Run", "Node", "Approval", "Revert"].map((I) => (() => {
      var x = Sr();
      return x.$$click = () => d(I.toLowerCase()), f(x, I), T(() => ie(x, ae("logs-filter px-2 py-0.5 text-[10px] border border-border rounded cursor-pointer", s().has(I.toLowerCase()) ? "bg-accent/20 text-accent" : "bg-panel-2 text-muted"))), x;
    })()), b), b.$$click = u, _.$$click = () => {
      const I = n() ? l() : c().map((x) => JSON.stringify(x)).join(`
`);
      navigator.clipboard?.writeText(I), se("info", "Copied");
    }, f(h, w(q, {
      get when() {
        return Le(() => !!n())() && l();
      },
      get children() {
        var I = uo(), x = I.firstChild, R = x.nextSibling;
        return f(R, l), I;
      }
    }), y), f(y, () => c().map((I) => JSON.stringify(I)).join(`
`)), T(() => ie(p, ae("logs-filter px-2 py-0.5 text-[10px] border border-border rounded cursor-pointer", n() ? "bg-accent/20 text-accent" : "bg-panel-2 text-muted"))), T(() => m.value = t()), h;
  })();
}
function ko(e) {
  const t = Q(() => $.outputs[e.runId]);
  return w(q, {
    get when() {
      return t();
    },
    get fallback() {
      return ho();
    },
    children: (r) => w(J, {
      get each() {
        return r().tables;
      },
      children: (n) => (() => {
        var o = po(), s = o.firstChild, a = s.firstChild, i = a.nextSibling;
        i.nextSibling;
        var l = s.nextSibling;
        return f(s, () => n.name, a), f(s, () => n.rows.length, i), f(l, () => JSON.stringify(n.rows, null, 2)), o;
      })()
    })
  });
}
function So(e) {
  const t = Q(() => $.attempts[e.runId]);
  return w(q, {
    get when() {
      return t();
    },
    get fallback() {
      return go();
    },
    children: (r) => w(J, {
      get each() {
        return r().attempts;
      },
      children: (n) => (() => {
        var o = mo(), s = o.firstChild, a = s.firstChild, i = a.nextSibling, l = i.firstChild, c = l.nextSibling;
        c.nextSibling;
        var d = s.nextSibling;
        return f(a, () => n.nodeId), f(i, () => n.iteration, c), f(i, () => n.attempt, null), f(s, w(q, {
          get when() {
            return n.errorJson;
          },
          get children() {
            var u = bo();
            return u.firstChild, f(u, () => String(n.errorJson).slice(0, 140), null), u;
          }
        }), null), f(d, () => n.state), o;
      })()
    })
  });
}
pe(["click", "input"]);
var _o = /* @__PURE__ */ S('<div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2"role=status aria-live=polite>'), Co = /* @__PURE__ */ S("<div>");
const Io = () => (() => {
  var e = _o();
  return f(e, w(J, {
    get each() {
      return $.toasts;
    },
    children: (t) => (() => {
      var r = Co();
      return f(r, () => t.message), T(() => ie(r, ae("toast px-4 py-3 rounded-md border bg-panel text-sm font-sans text-foreground shadow-lg max-w-xs", "animate-in slide-in-from-bottom-2 fade-in duration-200", `toast-${t.level}`, t.level === "info" && "border-l-[3px] border-l-accent border-border", t.level === "warning" && "border-l-[3px] border-l-warning border-border", t.level === "error" && "border-l-[3px] border-l-danger border-border"))), r;
    })()
  })), e;
})();
var Ao = /* @__PURE__ */ S('<div id=settings-panel-open class="flex flex-col flex-1 min-h-0 overflow-y-auto p-4 max-w-lg mx-auto w-full"><h2 class="text-xs font-semibold uppercase tracking-wide mb-4">Preferences</h2><div class="text-[10px] font-semibold text-muted uppercase tracking-widest mt-4 mb-1">UI</div><label class="text-[10px] text-muted uppercase tracking-wide mt-2">Inspector panel open</label><select class="w-full bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 focus:border-accent focus:outline-none"><option value=true>Open</option><option value=false>Closed</option></select><label class="text-[10px] text-muted uppercase tracking-wide mt-2">Inspector panel width</label><input id=settings-panel-width class="w-full bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 focus:border-accent focus:outline-none"type=number><div class="text-[10px] font-semibold text-muted uppercase tracking-widest mt-4 mb-1">AI Provider</div><label class="text-[10px] text-muted uppercase tracking-wide mt-2">Provider</label><select id=settings-provider class="w-full bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 focus:border-accent focus:outline-none"><option value=openai>OpenAI</option><option value=anthropic>Anthropic</option></select><label class="text-[10px] text-muted uppercase tracking-wide mt-2">Model</label><input id=settings-model class="w-full bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 focus:border-accent focus:outline-none"><label class="text-[10px] text-muted uppercase tracking-wide mt-2">Temperature</label><input id=settings-temperature class="w-full bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 focus:border-accent focus:outline-none"type=number step=0.1><label class="text-[10px] text-muted uppercase tracking-wide mt-2">Max tokens</label><input id=settings-max-tokens class="w-full bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 focus:border-accent focus:outline-none"type=number><label class="text-[10px] text-muted uppercase tracking-wide mt-2">System prompt</label><textarea id=settings-system-prompt class="w-full bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 focus:border-accent focus:outline-none font-mono min-h-[90px] resize-y"></textarea><div class="text-[10px] font-semibold text-muted uppercase tracking-widest mt-4 mb-1">API Keys</div><label class="text-[10px] text-muted uppercase tracking-wide mt-2">OpenAI API Key</label><div class="flex gap-1.5"><input id=settings-openai-key class="w-full bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 focus:border-accent focus:outline-none flex-1"type=password><button id=settings-openai-clear class="px-2 py-1 rounded border border-border bg-transparent text-muted text-[11px] uppercase cursor-pointer hover:text-foreground flex-shrink-0">Clear</button></div><label class="text-[10px] text-muted uppercase tracking-wide mt-2">Anthropic API Key</label><div class="flex gap-1.5"><input id=settings-anthropic-key class="w-full bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 focus:border-accent focus:outline-none flex-1"type=password><button id=settings-anthropic-clear class="px-2 py-1 rounded border border-border bg-transparent text-muted text-[11px] uppercase cursor-pointer hover:text-foreground flex-shrink-0">Clear</button></div><div class="text-[10px] font-semibold text-muted uppercase tracking-widest mt-4 mb-1">Tools</div><label class="text-[10px] text-muted uppercase tracking-wide mt-2">Bash network access</label><select id=settings-allow-network class="w-full bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 focus:border-accent focus:outline-none"><option value=false>Blocked</option><option value=true>Allowed</option></select><div class="flex justify-end gap-1.5 mt-6"><button id=settings-cancel class="px-3 py-1.5 rounded border border-border bg-transparent text-muted text-[11px] uppercase tracking-wide cursor-pointer hover:text-foreground">Cancel</button><button id=settings-save class="px-3 py-1.5 rounded bg-accent text-white text-[11px] font-semibold uppercase tracking-wide cursor-pointer">Save'), Ro = /* @__PURE__ */ S('<div class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"><div class="bg-panel border border-border rounded-xl w-[480px] max-h-[80vh] overflow-y-auto">');
const Lt = (e) => {
  const t = () => $.settings, [r, n] = L(t()?.ui.workflowPanel.isOpen ?? !0), [o, s] = L(t()?.ui.workflowPanel.width ?? 380), [a, i] = L(t()?.agent.provider ?? "openai"), [l, c] = L(t()?.agent.model ?? "gpt-4o-mini"), [d, u] = L(t()?.agent.temperature ?? 0.2), [h, g] = L(t()?.agent.maxTokens ?? 1024), [m, p] = L(t()?.agent.systemPrompt ?? ""), [b, _] = L(""), [y, I] = L(""), [x, R] = L(t()?.smithers?.allowNetwork ?? !1);
  $e(() => {
    const C = t();
    C && (e.modal && !e.open || (n(C.ui.workflowPanel.isOpen), s(C.ui.workflowPanel.width), i(C.agent.provider), c(C.agent.model), u(C.agent.temperature ?? 0.2), g(C.agent.maxTokens ?? 1024), p(C.agent.systemPrompt ?? ""), R(C.smithers?.allowNetwork ?? !1)));
  });
  const F = () => {
    e.onClose ? e.onClose() : E("currentView", "chat");
  }, H = async () => {
    const C = X(), A = l().trim() || (a() === "anthropic" ? "claude-3-5-sonnet-20241022" : "gpt-4o-mini"), D = await C.request.setSettings({
      patch: {
        ui: {
          workflowPanel: {
            isOpen: r(),
            width: o()
          }
        },
        agent: {
          provider: a(),
          model: A,
          temperature: d(),
          maxTokens: h(),
          systemPrompt: m()
        },
        smithers: {
          allowNetwork: x()
        }
      }
    });
    b().trim() && await C.request.setSecret({
      key: "openai.apiKey",
      value: b().trim()
    }), y().trim() && await C.request.setSecret({
      key: "anthropic.apiKey",
      value: y().trim()
    });
    const N = await C.request.getSecretStatus({});
    E({
      settings: D,
      secretStatus: N,
      inspectorOpen: D.ui.workflowPanel.isOpen
    }), se("info", "Settings saved."), F();
  }, k = async () => {
    await X().request.clearSecret({
      key: "openai.apiKey"
    });
    const C = await X().request.getSecretStatus({});
    E("secretStatus", C), se("info", "OpenAI API key cleared.");
  }, v = async () => {
    await X().request.clearSecret({
      key: "anthropic.apiKey"
    });
    const C = await X().request.getSecretStatus({});
    E("secretStatus", C), se("info", "Anthropic API key cleared.");
  }, O = (() => {
    var C = Ao(), A = C.firstChild, D = A.nextSibling, N = D.nextSibling, Z = N.nextSibling, ne = Z.nextSibling, P = ne.nextSibling, U = P.nextSibling, Y = U.nextSibling, j = Y.nextSibling, ee = j.nextSibling, _e = ee.nextSibling, Mr = _e.nextSibling, ot = Mr.nextSibling, qr = ot.nextSibling, it = qr.nextSibling, Fr = it.nextSibling, at = Fr.nextSibling, Dr = at.nextSibling, Nr = Dr.nextSibling, Ct = Nr.nextSibling, We = Ct.firstChild, Lr = We.nextSibling, jr = Ct.nextSibling, It = jr.nextSibling, ze = It.firstChild, Wr = ze.nextSibling, zr = It.nextSibling, Qr = zr.nextSibling, lt = Qr.nextSibling, Hr = lt.nextSibling, At = Hr.firstChild, Br = At.nextSibling;
    return Z.addEventListener("change", (W) => n(W.currentTarget.value === "true")), P.$$input = (W) => s(Number(W.currentTarget.value)), j.addEventListener("change", (W) => i(W.currentTarget.value)), _e.$$input = (W) => c(W.currentTarget.value), ot.$$input = (W) => u(Number(W.currentTarget.value)), it.$$input = (W) => g(Number(W.currentTarget.value)), at.$$input = (W) => p(W.currentTarget.value), We.$$input = (W) => _(W.currentTarget.value), Lr.$$click = k, ze.$$input = (W) => I(W.currentTarget.value), Wr.$$click = v, lt.addEventListener("change", (W) => R(W.currentTarget.value === "true")), At.$$click = F, Br.$$click = H, T((W) => {
      var Rt = $.secretStatus.openai ? "Configured" : "Not set", Ot = $.secretStatus.anthropic ? "Configured" : "Not set";
      return Rt !== W.e && K(We, "placeholder", W.e = Rt), Ot !== W.t && K(ze, "placeholder", W.t = Ot), W;
    }, {
      e: void 0,
      t: void 0
    }), T(() => Z.value = r() ? "true" : "false"), T(() => P.value = o()), T(() => j.value = a()), T(() => _e.value = l()), T(() => ot.value = d()), T(() => it.value = h()), T(() => at.value = m()), T(() => We.value = b()), T(() => ze.value = y()), T(() => lt.value = x() ? "true" : "false"), C;
  })();
  return e.modal ? w(q, {
    get when() {
      return e.open;
    },
    get children() {
      var C = Ro(), A = C.firstChild;
      return C.$$click = () => F(), A.$$click = (D) => D.stopPropagation(), f(A, O), C;
    }
  }) : O;
};
pe(["input", "click"]);
var Oo = /* @__PURE__ */ S('<div class="menubar flex items-center bg-[#07080A] border-b border-border h-7 px-2 gap-0 text-xs shrink-0 relative z-30"><div class=flex-1></div><button id=run-workflow class="px-2 py-0.5 text-[10px] text-muted hover:text-foreground bg-transparent border border-border rounded cursor-pointer">Run'), Po = /* @__PURE__ */ S('<div class=relative><button class="menu-item px-2 py-1 text-muted hover:text-foreground bg-transparent border-none cursor-pointer text-xs"></button><div class="menu-dropdown absolute top-full left-0 bg-panel border border-border rounded shadow-lg min-w-[160px] py-1 z-40">'), To = /* @__PURE__ */ S('<button class="menu-row w-full text-left px-3 py-1.5 text-xs text-foreground hover:bg-panel-2 bg-transparent border-none cursor-pointer">');
const Eo = (e) => {
  const [t, r] = L(null), n = [{
    key: "file",
    label: "File",
    items: [{
      label: "Open Workspace",
      action: () => {
        o(), e.onOpenWorkspace();
      }
    }, {
      label: "Close Workspace",
      action: () => {
        o(), e.onCloseWorkspace();
      }
    }]
  }, {
    key: "workflow",
    label: "Workflow",
    items: [{
      label: "Run Workflow",
      action: () => {
        o(), e.onRunWorkflow();
      }
    }]
  }, {
    key: "view",
    label: "View",
    items: [{
      label: "Zoom In",
      action: () => {
        o(), e.onZoomIn();
      }
    }]
  }, {
    key: "settings",
    label: "Settings",
    items: [{
      label: "Preferences",
      action: () => {
        o(), e.onPreferences();
      }
    }]
  }, {
    key: "help",
    label: "Help",
    items: [{
      label: "Docs",
      action: () => {
        o(), e.onDocs();
      }
    }]
  }], o = () => r(null), s = (a) => {
    a.target.closest(".menubar") || o();
  };
  return rr(() => document.addEventListener("click", s)), De(() => document.removeEventListener("click", s)), (() => {
    var a = Oo(), i = a.firstChild, l = i.nextSibling;
    return f(a, w(J, {
      each: n,
      children: (c) => (() => {
        var d = Po(), u = d.firstChild, h = u.nextSibling;
        return u.$$click = (g) => {
          g.stopPropagation(), r((m) => m === c.key ? null : c.key);
        }, f(u, () => c.label), f(h, w(J, {
          get each() {
            return c.items;
          },
          children: (g) => (() => {
            var m = To();
            return m.$$click = (p) => {
              p.stopPropagation(), g.action();
            }, f(m, () => g.label), m;
          })()
        })), T((g) => {
          var m = c.key, p = t() !== c.key;
          return m !== g.e && K(u, "data-menu", g.e = m), p !== g.t && h.classList.toggle("hidden", g.t = p), g;
        }, {
          e: void 0,
          t: void 0
        }), d;
      })()
    }), i), l.$$click = () => e.onRunWorkflow(), a;
  })();
};
pe(["click"]);
var Mo = /* @__PURE__ */ S('<button class="px-3 py-1.5 rounded border border-border bg-transparent text-muted text-[11px] uppercase tracking-wide cursor-pointer hover:text-foreground whitespace-nowrap">Browse…'), qo = /* @__PURE__ */ S('<div class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"><div class="bg-panel border border-border rounded-xl p-4 w-[420px] flex flex-col gap-3"><h2 class="text-xs font-semibold uppercase tracking-wide">Open Workspace</h2><div class="flex gap-1.5"><input id=workspace-path class="flex-1 bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 focus:border-accent focus:outline-none"placeholder="Enter workspace path…"></div><div class="flex justify-end gap-1.5"><button id=workspace-cancel class="px-3 py-1.5 rounded border border-border bg-transparent text-muted text-[11px] uppercase tracking-wide cursor-pointer hover:text-foreground">Cancel</button><button id=workspace-open class="px-3 py-1.5 rounded bg-accent text-white text-[11px] font-semibold uppercase tracking-wide cursor-pointer">Open');
const Fo = (e) => {
  const [t, r] = L("");
  $e(() => {
    e.open && r("");
  });
  const n = async () => {
    if (!e.browseDirectory) return;
    const s = await e.browseDirectory();
    s && r(s);
  }, o = async () => {
    const s = t().trim();
    if (s)
      try {
        await X().request.openWorkspace({
          path: s
        });
        const a = await X().request.getWorkspaceState({});
        E({
          workspaceRoot: a.root,
          workflows: a.workflows
        }), await ce(), e.onClose();
      } catch (a) {
        se("error", `Failed to open workspace: ${a?.message ?? a}`);
      }
  };
  return w(q, {
    get when() {
      return e.open;
    },
    get children() {
      var s = qo(), a = s.firstChild, i = a.firstChild, l = i.nextSibling, c = l.firstChild, d = l.nextSibling, u = d.firstChild, h = u.nextSibling;
      return s.$$click = () => e.onClose(), a.$$click = (g) => g.stopPropagation(), c.$$keydown = (g) => {
        g.key === "Enter" && o();
      }, c.$$input = (g) => r(g.currentTarget.value), f(l, w(q, {
        get when() {
          return e.browseDirectory;
        },
        get children() {
          var g = Mo();
          return g.$$click = n, g;
        }
      }), null), u.$$click = () => e.onClose(), h.$$click = o, T(() => c.value = t()), s;
    }
  });
};
pe(["click", "input", "keydown"]);
var Do = /* @__PURE__ */ S('<div class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50"><div class="bg-panel border border-border rounded-xl p-4 w-[420px] flex flex-col gap-2 max-h-[80vh] overflow-y-auto"><h2 class="text-xs font-semibold uppercase tracking-wide">Run Workflow</h2><label class="text-[10px] text-muted uppercase tracking-wide">Workflow</label><select id=workflow-select class="bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 focus:border-accent focus:outline-none"></select><label class="text-[10px] text-muted uppercase tracking-wide">Input (JSON)</label><textarea id=workflow-input class="bg-background border border-border text-foreground text-xs rounded-lg px-2 py-1.5 font-mono min-h-[90px] resize-y focus:border-accent focus:outline-none"></textarea><div class="flex justify-end gap-1.5 mt-2"><button id=modal-cancel class="px-3 py-1.5 rounded border border-border bg-transparent text-muted text-[11px] uppercase tracking-wide cursor-pointer hover:text-foreground">Cancel</button><button id=modal-run class="px-3 py-1.5 rounded bg-accent text-white text-[11px] font-semibold uppercase tracking-wide cursor-pointer">Run'), No = /* @__PURE__ */ S("<option>");
const Lo = (e) => {
  const [t, r] = L(""), [n, o] = L("{}");
  $e(() => {
    if (e.open) {
      const a = e.preselect ?? $.workflows[0]?.path ?? "";
      r(a), o("{}");
    }
  });
  const s = async () => {
    const a = t();
    if (!a) {
      se("warning", "No workflow selected.");
      return;
    }
    let i = {};
    try {
      i = JSON.parse(n());
    } catch {
      i = {};
    }
    const l = await X().request.runWorkflow({
      workflowPath: a,
      input: i,
      attachToSessionId: $.sessionId || void 0
    });
    e.onClose(), await ce(), await ue(l.runId);
  };
  return w(q, {
    get when() {
      return e.open;
    },
    get children() {
      var a = Do(), i = a.firstChild, l = i.firstChild, c = l.nextSibling, d = c.nextSibling, u = d.nextSibling, h = u.nextSibling, g = h.nextSibling, m = g.firstChild, p = m.nextSibling;
      return a.$$click = () => e.onClose(), i.$$click = (b) => b.stopPropagation(), d.addEventListener("change", (b) => r(b.currentTarget.value)), f(d, w(J, {
        get each() {
          return $.workflows;
        },
        children: (b) => (() => {
          var _ = No();
          return f(_, () => b.name ?? b.path), T(() => _.value = b.path), _;
        })()
      })), h.$$input = (b) => o(b.currentTarget.value), m.$$click = () => e.onClose(), p.$$click = s, T(() => d.value = t()), T(() => h.value = n()), a;
    }
  });
};
pe(["click", "input"]);
var jo = /* @__PURE__ */ S('<div class="app flex flex-col h-screen overflow-hidden"><div class="flex flex-1 min-h-0 overflow-hidden transition-all duration-300"><main class="flex flex-col min-w-0 overflow-hidden flex-1"><div class="flex flex-col flex-1 min-h-0 overflow-hidden"></div><div class="flex flex-col flex-1 min-h-0 overflow-hidden"></div><div class="flex flex-col flex-1 min-h-0 overflow-hidden">'), Wo = /* @__PURE__ */ S('<div class="flex flex-col flex-1 min-h-0 overflow-hidden">');
const zo = () => {
  const [e, t] = L(!1), [r, n] = L(!1), [o, s] = L(!1), [a, i] = L(void 0), l = (d) => {
    i(d), n(!0);
  }, c = (d) => {
    (d.ctrlKey || d.metaKey) && d.key === "\\" && (d.shiftKey ? document.body.classList.toggle("artifacts-hidden") : E({
      inspectorOpen: !$.inspectorOpen,
      inspectorExpanded: !1
    }), d.preventDefault()), (d.ctrlKey || d.metaKey) && d.key.toLowerCase() === "r" && !d.shiftKey && (d.preventDefault(), n(!0)), d.key === "Escape" && (e() ? t(!1) : r() ? n(!1) : o() ? s(!1) : $.inspectorExpanded ? E("inspectorExpanded", !1) : $.inspectorOpen && E("inspectorOpen", !1));
  };
  return rr(() => {
    document.addEventListener("keydown", c);
  }), De(() => {
    document.removeEventListener("keydown", c);
  }), (() => {
    var d = jo(), u = d.firstChild, h = u.firstChild, g = h.firstChild, m = g.nextSibling, p = m.nextSibling;
    return f(d, w(Eo, {
      onOpenWorkspace: () => t(!0),
      onCloseWorkspace: () => {
        Promise.resolve().then(() => Gt).then(({
          getRpc: b
        }) => {
          b().request.openWorkspace({
            path: ""
          }).then(async () => {
            const _ = await b().request.getWorkspaceState({});
            E({
              workspaceRoot: _.root,
              workflows: _.workflows
            });
          });
        });
      },
      onRunWorkflow: () => l(),
      onPreferences: () => s(!0),
      onDocs: () => se("info", "smithers.sh"),
      onZoomIn: () => E("graphZoom", (b) => b * 1.2)
    }), u), f(u, w(Hs, {}), h), f(g, w(_s, {
      onRunWorkflow: l
    })), f(m, w(Ms, {})), f(p, w(Ns, {
      onRunWorkflow: l
    })), f(h, (() => {
      var b = Le(() => $.currentView === "settings");
      return () => b() && (() => {
        var _ = Wo();
        return f(_, w(Lt, {
          onClose: () => E("currentView", "chat")
        })), _;
      })();
    })(), null), f(u, w(vo, {}), null), f(d, w(Fo, {
      get open() {
        return e();
      },
      onClose: () => t(!1),
      browseDirectory: async () => {
        const {
          getRpc: b
        } = await Promise.resolve().then(() => Gt);
        return (await b().request.browseDirectory({})).path;
      }
    }), null), f(d, w(Lo, {
      get open() {
        return r();
      },
      onClose: () => n(!1),
      get preselect() {
        return a();
      }
    }), null), f(d, w(Lt, {
      modal: !0,
      get open() {
        return o();
      },
      onClose: () => s(!1)
    }), null), f(d, w(Io, {}), null), T((b) => {
      var _ = $.currentView === "chat" ? void 0 : "none", y = $.currentView === "runs" ? void 0 : "none", I = $.currentView === "workflows" ? void 0 : "none";
      return _ !== b.e && Pe(g, "display", b.e = _), y !== b.t && Pe(m, "display", b.t = y), I !== b.a && Pe(p, "display", b.a = I), b;
    }, {
      e: void 0,
      t: void 0,
      a: void 0
    }), d;
  })();
}, Qo = nr();
function Ho(e) {
  return w(Qo.Provider, {
    get value() {
      return e.client;
    },
    get children() {
      return e.children;
    }
  });
}
var nt = class {
  constructor() {
    this.listeners = /* @__PURE__ */ new Set(), this.subscribe = this.subscribe.bind(this);
  }
  subscribe(e) {
    return this.listeners.add(e), this.onSubscribe(), () => {
      this.listeners.delete(e), this.onUnsubscribe();
    };
  }
  hasListeners() {
    return this.listeners.size > 0;
  }
  onSubscribe() {
  }
  onUnsubscribe() {
  }
}, Bo = {
  // We need the wrapper function syntax below instead of direct references to
  // global setTimeout etc.
  //
  // BAD: `setTimeout: setTimeout`
  // GOOD: `setTimeout: (cb, delay) => setTimeout(cb, delay)`
  //
  // If we use direct references here, then anything that wants to spy on or
  // replace the global setTimeout (like tests) won't work since we'll already
  // have a hard reference to the original implementation at the time when this
  // file was imported.
  setTimeout: (e, t) => setTimeout(e, t),
  clearTimeout: (e) => clearTimeout(e),
  setInterval: (e, t) => setInterval(e, t),
  clearInterval: (e) => clearInterval(e)
}, Uo = class {
  // We cannot have TimeoutManager<T> as we must instantiate it with a concrete
  // type at app boot; and if we leave that type, then any new timer provider
  // would need to support ReturnType<typeof setTimeout>, which is infeasible.
  //
  // We settle for type safety for the TimeoutProvider type, and accept that
  // this class is unsafe internally to allow for extension.
  #e = Bo;
  #t = !1;
  setTimeoutProvider(e) {
    process.env.NODE_ENV !== "production" && this.#t && e !== this.#e && console.error(
      "[timeoutManager]: Switching provider after calls to previous provider might result in unexpected behavior.",
      { previous: this.#e, provider: e }
    ), this.#e = e, process.env.NODE_ENV !== "production" && (this.#t = !1);
  }
  setTimeout(e, t) {
    return process.env.NODE_ENV !== "production" && (this.#t = !0), this.#e.setTimeout(e, t);
  }
  clearTimeout(e) {
    this.#e.clearTimeout(e);
  }
  setInterval(e, t) {
    return process.env.NODE_ENV !== "production" && (this.#t = !0), this.#e.setInterval(e, t);
  }
  clearInterval(e) {
    this.#e.clearInterval(e);
  }
}, mt = new Uo();
function Ko(e) {
  setTimeout(e, 0);
}
var st = typeof window > "u" || "Deno" in globalThis;
function le() {
}
function Go(e, t) {
  return typeof e == "function" ? e(t) : e;
}
function Vo(e) {
  return typeof e == "number" && e >= 0 && e !== 1 / 0;
}
function Jo(e, t) {
  return Math.max(e + (t || 0) - Date.now(), 0);
}
function wt(e, t) {
  return typeof e == "function" ? e(t) : e;
}
function Zo(e, t) {
  return typeof e == "function" ? e(t) : e;
}
function jt(e, t) {
  const {
    type: r = "all",
    exact: n,
    fetchStatus: o,
    predicate: s,
    queryKey: a,
    stale: i
  } = e;
  if (a) {
    if (n) {
      if (t.queryHash !== St(a, t.options))
        return !1;
    } else if (!Fe(t.queryKey, a))
      return !1;
  }
  if (r !== "all") {
    const l = t.isActive();
    if (r === "active" && !l || r === "inactive" && l)
      return !1;
  }
  return !(typeof i == "boolean" && t.isStale() !== i || o && o !== t.state.fetchStatus || s && !s(t));
}
function Wt(e, t) {
  const { exact: r, status: n, predicate: o, mutationKey: s } = e;
  if (s) {
    if (!t.options.mutationKey)
      return !1;
    if (r) {
      if (qe(t.options.mutationKey) !== qe(s))
        return !1;
    } else if (!Fe(t.options.mutationKey, s))
      return !1;
  }
  return !(n && t.state.status !== n || o && !o(t));
}
function St(e, t) {
  return (t?.queryKeyHashFn || qe)(e);
}
function qe(e) {
  return JSON.stringify(
    e,
    (t, r) => xt(r) ? Object.keys(r).sort().reduce((n, o) => (n[o] = r[o], n), {}) : r
  );
}
function Fe(e, t) {
  return e === t ? !0 : typeof e != typeof t ? !1 : e && t && typeof e == "object" && typeof t == "object" ? Object.keys(t).every((r) => Fe(e[r], t[r])) : !1;
}
var Xo = Object.prototype.hasOwnProperty;
function vt(e, t, r = 0) {
  if (e === t)
    return e;
  if (r > 500) return t;
  const n = zt(e) && zt(t);
  if (!n && !(xt(e) && xt(t))) return t;
  const s = (n ? e : Object.keys(e)).length, a = n ? t : Object.keys(t), i = a.length, l = n ? new Array(i) : {};
  let c = 0;
  for (let d = 0; d < i; d++) {
    const u = n ? d : a[d], h = e[u], g = t[u];
    if (h === g) {
      l[u] = h, (n ? d < s : Xo.call(e, u)) && c++;
      continue;
    }
    if (h === null || g === null || typeof h != "object" || typeof g != "object") {
      l[u] = g;
      continue;
    }
    const m = vt(h, g, r + 1);
    l[u] = m, m === h && c++;
  }
  return s === i && c === s ? e : l;
}
function zt(e) {
  return Array.isArray(e) && e.length === Object.keys(e).length;
}
function xt(e) {
  if (!Qt(e))
    return !1;
  const t = e.constructor;
  if (t === void 0)
    return !0;
  const r = t.prototype;
  return !(!Qt(r) || !r.hasOwnProperty("isPrototypeOf") || Object.getPrototypeOf(e) !== Object.prototype);
}
function Qt(e) {
  return Object.prototype.toString.call(e) === "[object Object]";
}
function Yo(e) {
  return new Promise((t) => {
    mt.setTimeout(t, e);
  });
}
function ei(e, t, r) {
  if (typeof r.structuralSharing == "function")
    return r.structuralSharing(e, t);
  if (r.structuralSharing !== !1) {
    if (process.env.NODE_ENV !== "production")
      try {
        return vt(e, t);
      } catch (n) {
        throw console.error(
          `Structural sharing requires data to be JSON serializable. To fix this, turn off structuralSharing or return JSON-serializable data from your queryFn. [${r.queryHash}]: ${n}`
        ), n;
      }
    return vt(e, t);
  }
  return t;
}
function ti(e, t, r = 0) {
  const n = [...e, t];
  return r && n.length > r ? n.slice(1) : n;
}
function ri(e, t, r = 0) {
  const n = [t, ...e];
  return r && n.length > r ? n.slice(0, -1) : n;
}
var et = /* @__PURE__ */ Symbol();
function _r(e, t) {
  return process.env.NODE_ENV !== "production" && e.queryFn === et && console.error(
    `Attempted to invoke queryFn when set to skipToken. This is likely a configuration error. Query hash: '${e.queryHash}'`
  ), !e.queryFn && t?.initialPromise ? () => t.initialPromise : !e.queryFn || e.queryFn === et ? () => Promise.reject(new Error(`Missing queryFn: '${e.queryHash}'`)) : e.queryFn;
}
function ni(e, t, r) {
  let n = !1, o;
  return Object.defineProperty(e, "signal", {
    enumerable: !0,
    get: () => (o ??= t(), n || (n = !0, o.aborted ? r() : o.addEventListener("abort", r, { once: !0 })), o)
  }), e;
}
var si = class extends nt {
  #e;
  #t;
  #r;
  constructor() {
    super(), this.#r = (e) => {
      if (!st && window.addEventListener) {
        const t = () => e();
        return window.addEventListener("visibilitychange", t, !1), () => {
          window.removeEventListener("visibilitychange", t);
        };
      }
    };
  }
  onSubscribe() {
    this.#t || this.setEventListener(this.#r);
  }
  onUnsubscribe() {
    this.hasListeners() || (this.#t?.(), this.#t = void 0);
  }
  setEventListener(e) {
    this.#r = e, this.#t?.(), this.#t = e((t) => {
      typeof t == "boolean" ? this.setFocused(t) : this.onFocus();
    });
  }
  setFocused(e) {
    this.#e !== e && (this.#e = e, this.onFocus());
  }
  onFocus() {
    const e = this.isFocused();
    this.listeners.forEach((t) => {
      t(e);
    });
  }
  isFocused() {
    return typeof this.#e == "boolean" ? this.#e : globalThis.document?.visibilityState !== "hidden";
  }
}, Cr = new si();
function oi() {
  let e, t;
  const r = new Promise((o, s) => {
    e = o, t = s;
  });
  r.status = "pending", r.catch(() => {
  });
  function n(o) {
    Object.assign(r, o), delete r.resolve, delete r.reject;
  }
  return r.resolve = (o) => {
    n({
      status: "fulfilled",
      value: o
    }), e(o);
  }, r.reject = (o) => {
    n({
      status: "rejected",
      reason: o
    }), t(o);
  }, r;
}
var ii = Ko;
function ai() {
  let e = [], t = 0, r = (i) => {
    i();
  }, n = (i) => {
    i();
  }, o = ii;
  const s = (i) => {
    t ? e.push(i) : o(() => {
      r(i);
    });
  }, a = () => {
    const i = e;
    e = [], i.length && o(() => {
      n(() => {
        i.forEach((l) => {
          r(l);
        });
      });
    });
  };
  return {
    batch: (i) => {
      let l;
      t++;
      try {
        l = i();
      } finally {
        t--, t || a();
      }
      return l;
    },
    /**
     * All calls to the wrapped function will be batched.
     */
    batchCalls: (i) => (...l) => {
      s(() => {
        i(...l);
      });
    },
    schedule: s,
    /**
     * Use this method to set a custom notify function.
     * This can be used to for example wrap notifications with `React.act` while running tests.
     */
    setNotifyFunction: (i) => {
      r = i;
    },
    /**
     * Use this method to set a custom function to batch notifications together into a single tick.
     * By default React Query will use the batch function provided by ReactDOM or React Native.
     */
    setBatchNotifyFunction: (i) => {
      n = i;
    },
    setScheduler: (i) => {
      o = i;
    }
  };
}
var re = ai(), li = class extends nt {
  #e = !0;
  #t;
  #r;
  constructor() {
    super(), this.#r = (e) => {
      if (!st && window.addEventListener) {
        const t = () => e(!0), r = () => e(!1);
        return window.addEventListener("online", t, !1), window.addEventListener("offline", r, !1), () => {
          window.removeEventListener("online", t), window.removeEventListener("offline", r);
        };
      }
    };
  }
  onSubscribe() {
    this.#t || this.setEventListener(this.#r);
  }
  onUnsubscribe() {
    this.hasListeners() || (this.#t?.(), this.#t = void 0);
  }
  setEventListener(e) {
    this.#r = e, this.#t?.(), this.#t = e(this.setOnline.bind(this));
  }
  setOnline(e) {
    this.#e !== e && (this.#e = e, this.listeners.forEach((r) => {
      r(e);
    }));
  }
  isOnline() {
    return this.#e;
  }
}, tt = new li();
function ci(e) {
  return Math.min(1e3 * 2 ** e, 3e4);
}
function Ir(e) {
  return (e ?? "online") === "online" ? tt.isOnline() : !0;
}
var yt = class extends Error {
  constructor(e) {
    super("CancelledError"), this.revert = e?.revert, this.silent = e?.silent;
  }
};
function Ar(e) {
  let t = !1, r = 0, n;
  const o = oi(), s = () => o.status !== "pending", a = (p) => {
    if (!s()) {
      const b = new yt(p);
      h(b), e.onCancel?.(b);
    }
  }, i = () => {
    t = !0;
  }, l = () => {
    t = !1;
  }, c = () => Cr.isFocused() && (e.networkMode === "always" || tt.isOnline()) && e.canRun(), d = () => Ir(e.networkMode) && e.canRun(), u = (p) => {
    s() || (n?.(), o.resolve(p));
  }, h = (p) => {
    s() || (n?.(), o.reject(p));
  }, g = () => new Promise((p) => {
    n = (b) => {
      (s() || c()) && p(b);
    }, e.onPause?.();
  }).then(() => {
    n = void 0, s() || e.onContinue?.();
  }), m = () => {
    if (s())
      return;
    let p;
    const b = r === 0 ? e.initialPromise : void 0;
    try {
      p = b ?? e.fn();
    } catch (_) {
      p = Promise.reject(_);
    }
    Promise.resolve(p).then(u).catch((_) => {
      if (s())
        return;
      const y = e.retry ?? (st ? 0 : 3), I = e.retryDelay ?? ci, x = typeof I == "function" ? I(r, _) : I, R = y === !0 || typeof y == "number" && r < y || typeof y == "function" && y(r, _);
      if (t || !R) {
        h(_);
        return;
      }
      r++, e.onFail?.(r, _), Yo(x).then(() => c() ? void 0 : g()).then(() => {
        t ? h(_) : m();
      });
    });
  };
  return {
    promise: o,
    status: () => o.status,
    cancel: a,
    continue: () => (n?.(), o),
    cancelRetry: i,
    continueRetry: l,
    canStart: d,
    start: () => (d() ? m() : g().then(m), o)
  };
}
var Rr = class {
  #e;
  destroy() {
    this.clearGcTimeout();
  }
  scheduleGc() {
    this.clearGcTimeout(), Vo(this.gcTime) && (this.#e = mt.setTimeout(() => {
      this.optionalRemove();
    }, this.gcTime));
  }
  updateGcTime(e) {
    this.gcTime = Math.max(
      this.gcTime || 0,
      e ?? (st ? 1 / 0 : 300 * 1e3)
    );
  }
  clearGcTimeout() {
    this.#e && (mt.clearTimeout(this.#e), this.#e = void 0);
  }
}, ui = class extends Rr {
  #e;
  #t;
  #r;
  #s;
  #n;
  #i;
  #a;
  constructor(e) {
    super(), this.#a = !1, this.#i = e.defaultOptions, this.setOptions(e.options), this.observers = [], this.#s = e.client, this.#r = this.#s.getQueryCache(), this.queryKey = e.queryKey, this.queryHash = e.queryHash, this.#e = Bt(this.options), this.state = e.state ?? this.#e, this.scheduleGc();
  }
  get meta() {
    return this.options.meta;
  }
  get promise() {
    return this.#n?.promise;
  }
  setOptions(e) {
    if (this.options = { ...this.#i, ...e }, this.updateGcTime(this.options.gcTime), this.state && this.state.data === void 0) {
      const t = Bt(this.options);
      t.data !== void 0 && (this.setState(
        Ht(t.data, t.dataUpdatedAt)
      ), this.#e = t);
    }
  }
  optionalRemove() {
    !this.observers.length && this.state.fetchStatus === "idle" && this.#r.remove(this);
  }
  setData(e, t) {
    const r = ei(this.state.data, e, this.options);
    return this.#o({
      data: r,
      type: "success",
      dataUpdatedAt: t?.updatedAt,
      manual: t?.manual
    }), r;
  }
  setState(e, t) {
    this.#o({ type: "setState", state: e, setStateOptions: t });
  }
  cancel(e) {
    const t = this.#n?.promise;
    return this.#n?.cancel(e), t ? t.then(le).catch(le) : Promise.resolve();
  }
  destroy() {
    super.destroy(), this.cancel({ silent: !0 });
  }
  reset() {
    this.destroy(), this.setState(this.#e);
  }
  isActive() {
    return this.observers.some(
      (e) => Zo(e.options.enabled, this) !== !1
    );
  }
  isDisabled() {
    return this.getObserversCount() > 0 ? !this.isActive() : this.options.queryFn === et || this.state.dataUpdateCount + this.state.errorUpdateCount === 0;
  }
  isStatic() {
    return this.getObserversCount() > 0 ? this.observers.some(
      (e) => wt(e.options.staleTime, this) === "static"
    ) : !1;
  }
  isStale() {
    return this.getObserversCount() > 0 ? this.observers.some(
      (e) => e.getCurrentResult().isStale
    ) : this.state.data === void 0 || this.state.isInvalidated;
  }
  isStaleByTime(e = 0) {
    return this.state.data === void 0 ? !0 : e === "static" ? !1 : this.state.isInvalidated ? !0 : !Jo(this.state.dataUpdatedAt, e);
  }
  onFocus() {
    this.observers.find((t) => t.shouldFetchOnWindowFocus())?.refetch({ cancelRefetch: !1 }), this.#n?.continue();
  }
  onOnline() {
    this.observers.find((t) => t.shouldFetchOnReconnect())?.refetch({ cancelRefetch: !1 }), this.#n?.continue();
  }
  addObserver(e) {
    this.observers.includes(e) || (this.observers.push(e), this.clearGcTimeout(), this.#r.notify({ type: "observerAdded", query: this, observer: e }));
  }
  removeObserver(e) {
    this.observers.includes(e) && (this.observers = this.observers.filter((t) => t !== e), this.observers.length || (this.#n && (this.#a ? this.#n.cancel({ revert: !0 }) : this.#n.cancelRetry()), this.scheduleGc()), this.#r.notify({ type: "observerRemoved", query: this, observer: e }));
  }
  getObserversCount() {
    return this.observers.length;
  }
  invalidate() {
    this.state.isInvalidated || this.#o({ type: "invalidate" });
  }
  async fetch(e, t) {
    if (this.state.fetchStatus !== "idle" && // If the promise in the retryer is already rejected, we have to definitely
    // re-start the fetch; there is a chance that the query is still in a
    // pending state when that happens
    this.#n?.status() !== "rejected") {
      if (this.state.data !== void 0 && t?.cancelRefetch)
        this.cancel({ silent: !0 });
      else if (this.#n)
        return this.#n.continueRetry(), this.#n.promise;
    }
    if (e && this.setOptions(e), !this.options.queryFn) {
      const i = this.observers.find((l) => l.options.queryFn);
      i && this.setOptions(i.options);
    }
    process.env.NODE_ENV !== "production" && (Array.isArray(this.options.queryKey) || console.error(
      "As of v4, queryKey needs to be an Array. If you are using a string like 'repoData', please change it to an Array, e.g. ['repoData']"
    ));
    const r = new AbortController(), n = (i) => {
      Object.defineProperty(i, "signal", {
        enumerable: !0,
        get: () => (this.#a = !0, r.signal)
      });
    }, o = () => {
      const i = _r(this.options, t), c = (() => {
        const d = {
          client: this.#s,
          queryKey: this.queryKey,
          meta: this.meta
        };
        return n(d), d;
      })();
      return this.#a = !1, this.options.persister ? this.options.persister(
        i,
        c,
        this
      ) : i(c);
    }, a = (() => {
      const i = {
        fetchOptions: t,
        options: this.options,
        queryKey: this.queryKey,
        client: this.#s,
        state: this.state,
        fetchFn: o
      };
      return n(i), i;
    })();
    this.options.behavior?.onFetch(a, this), this.#t = this.state, (this.state.fetchStatus === "idle" || this.state.fetchMeta !== a.fetchOptions?.meta) && this.#o({ type: "fetch", meta: a.fetchOptions?.meta }), this.#n = Ar({
      initialPromise: t?.initialPromise,
      fn: a.fetchFn,
      onCancel: (i) => {
        i instanceof yt && i.revert && this.setState({
          ...this.#t,
          fetchStatus: "idle"
        }), r.abort();
      },
      onFail: (i, l) => {
        this.#o({ type: "failed", failureCount: i, error: l });
      },
      onPause: () => {
        this.#o({ type: "pause" });
      },
      onContinue: () => {
        this.#o({ type: "continue" });
      },
      retry: a.options.retry,
      retryDelay: a.options.retryDelay,
      networkMode: a.options.networkMode,
      canRun: () => !0
    });
    try {
      const i = await this.#n.start();
      if (i === void 0)
        throw process.env.NODE_ENV !== "production" && console.error(
          `Query data cannot be undefined. Please make sure to return a value other than undefined from your query function. Affected query key: ${this.queryHash}`
        ), new Error(`${this.queryHash} data is undefined`);
      return this.setData(i), this.#r.config.onSuccess?.(i, this), this.#r.config.onSettled?.(
        i,
        this.state.error,
        this
      ), i;
    } catch (i) {
      if (i instanceof yt) {
        if (i.silent)
          return this.#n.promise;
        if (i.revert) {
          if (this.state.data === void 0)
            throw i;
          return this.state.data;
        }
      }
      throw this.#o({
        type: "error",
        error: i
      }), this.#r.config.onError?.(
        i,
        this
      ), this.#r.config.onSettled?.(
        this.state.data,
        i,
        this
      ), i;
    } finally {
      this.scheduleGc();
    }
  }
  #o(e) {
    const t = (r) => {
      switch (e.type) {
        case "failed":
          return {
            ...r,
            fetchFailureCount: e.failureCount,
            fetchFailureReason: e.error
          };
        case "pause":
          return {
            ...r,
            fetchStatus: "paused"
          };
        case "continue":
          return {
            ...r,
            fetchStatus: "fetching"
          };
        case "fetch":
          return {
            ...r,
            ...di(r.data, this.options),
            fetchMeta: e.meta ?? null
          };
        case "success":
          const n = {
            ...r,
            ...Ht(e.data, e.dataUpdatedAt),
            dataUpdateCount: r.dataUpdateCount + 1,
            ...!e.manual && {
              fetchStatus: "idle",
              fetchFailureCount: 0,
              fetchFailureReason: null
            }
          };
          return this.#t = e.manual ? n : void 0, n;
        case "error":
          const o = e.error;
          return {
            ...r,
            error: o,
            errorUpdateCount: r.errorUpdateCount + 1,
            errorUpdatedAt: Date.now(),
            fetchFailureCount: r.fetchFailureCount + 1,
            fetchFailureReason: o,
            fetchStatus: "idle",
            status: "error",
            // flag existing data as invalidated if we get a background error
            // note that "no data" always means stale so we can set unconditionally here
            isInvalidated: !0
          };
        case "invalidate":
          return {
            ...r,
            isInvalidated: !0
          };
        case "setState":
          return {
            ...r,
            ...e.state
          };
      }
    };
    this.state = t(this.state), re.batch(() => {
      this.observers.forEach((r) => {
        r.onQueryUpdate();
      }), this.#r.notify({ query: this, type: "updated", action: e });
    });
  }
};
function di(e, t) {
  return {
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchStatus: Ir(t.networkMode) ? "fetching" : "paused",
    ...e === void 0 && {
      error: null,
      status: "pending"
    }
  };
}
function Ht(e, t) {
  return {
    data: e,
    dataUpdatedAt: t ?? Date.now(),
    error: null,
    isInvalidated: !1,
    status: "success"
  };
}
function Bt(e) {
  const t = typeof e.initialData == "function" ? e.initialData() : e.initialData, r = t !== void 0, n = r ? typeof e.initialDataUpdatedAt == "function" ? e.initialDataUpdatedAt() : e.initialDataUpdatedAt : 0;
  return {
    data: t,
    dataUpdateCount: 0,
    dataUpdatedAt: r ? n ?? Date.now() : 0,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchMeta: null,
    isInvalidated: !1,
    status: r ? "success" : "pending",
    fetchStatus: "idle"
  };
}
function Ut(e) {
  return {
    onFetch: (t, r) => {
      const n = t.options, o = t.fetchOptions?.meta?.fetchMore?.direction, s = t.state.data?.pages || [], a = t.state.data?.pageParams || [];
      let i = { pages: [], pageParams: [] }, l = 0;
      const c = async () => {
        let d = !1;
        const u = (m) => {
          ni(
            m,
            () => t.signal,
            () => d = !0
          );
        }, h = _r(t.options, t.fetchOptions), g = async (m, p, b) => {
          if (d)
            return Promise.reject();
          if (p == null && m.pages.length)
            return Promise.resolve(m);
          const y = (() => {
            const F = {
              client: t.client,
              queryKey: t.queryKey,
              pageParam: p,
              direction: b ? "backward" : "forward",
              meta: t.options.meta
            };
            return u(F), F;
          })(), I = await h(y), { maxPages: x } = t.options, R = b ? ri : ti;
          return {
            pages: R(m.pages, I, x),
            pageParams: R(m.pageParams, p, x)
          };
        };
        if (o && s.length) {
          const m = o === "backward", p = m ? fi : Kt, b = {
            pages: s,
            pageParams: a
          }, _ = p(n, b);
          i = await g(b, _, m);
        } else {
          const m = e ?? s.length;
          do {
            const p = l === 0 ? a[0] ?? n.initialPageParam : Kt(n, i);
            if (l > 0 && p == null)
              break;
            i = await g(i, p), l++;
          } while (l < m);
        }
        return i;
      };
      t.options.persister ? t.fetchFn = () => t.options.persister?.(
        c,
        {
          client: t.client,
          queryKey: t.queryKey,
          meta: t.options.meta,
          signal: t.signal
        },
        r
      ) : t.fetchFn = c;
    }
  };
}
function Kt(e, { pages: t, pageParams: r }) {
  const n = t.length - 1;
  return t.length > 0 ? e.getNextPageParam(
    t[n],
    t,
    r[n],
    r
  ) : void 0;
}
function fi(e, { pages: t, pageParams: r }) {
  return t.length > 0 ? e.getPreviousPageParam?.(t[0], t, r[0], r) : void 0;
}
var hi = class extends Rr {
  #e;
  #t;
  #r;
  #s;
  constructor(e) {
    super(), this.#e = e.client, this.mutationId = e.mutationId, this.#r = e.mutationCache, this.#t = [], this.state = e.state || pi(), this.setOptions(e.options), this.scheduleGc();
  }
  setOptions(e) {
    this.options = e, this.updateGcTime(this.options.gcTime);
  }
  get meta() {
    return this.options.meta;
  }
  addObserver(e) {
    this.#t.includes(e) || (this.#t.push(e), this.clearGcTimeout(), this.#r.notify({
      type: "observerAdded",
      mutation: this,
      observer: e
    }));
  }
  removeObserver(e) {
    this.#t = this.#t.filter((t) => t !== e), this.scheduleGc(), this.#r.notify({
      type: "observerRemoved",
      mutation: this,
      observer: e
    });
  }
  optionalRemove() {
    this.#t.length || (this.state.status === "pending" ? this.scheduleGc() : this.#r.remove(this));
  }
  continue() {
    return this.#s?.continue() ?? // continuing a mutation assumes that variables are set, mutation must have been dehydrated before
    this.execute(this.state.variables);
  }
  async execute(e) {
    const t = () => {
      this.#n({ type: "continue" });
    }, r = {
      client: this.#e,
      meta: this.options.meta,
      mutationKey: this.options.mutationKey
    };
    this.#s = Ar({
      fn: () => this.options.mutationFn ? this.options.mutationFn(e, r) : Promise.reject(new Error("No mutationFn found")),
      onFail: (s, a) => {
        this.#n({ type: "failed", failureCount: s, error: a });
      },
      onPause: () => {
        this.#n({ type: "pause" });
      },
      onContinue: t,
      retry: this.options.retry ?? 0,
      retryDelay: this.options.retryDelay,
      networkMode: this.options.networkMode,
      canRun: () => this.#r.canRun(this)
    });
    const n = this.state.status === "pending", o = !this.#s.canStart();
    try {
      if (n)
        t();
      else {
        this.#n({ type: "pending", variables: e, isPaused: o }), this.#r.config.onMutate && await this.#r.config.onMutate(
          e,
          this,
          r
        );
        const a = await this.options.onMutate?.(
          e,
          r
        );
        a !== this.state.context && this.#n({
          type: "pending",
          context: a,
          variables: e,
          isPaused: o
        });
      }
      const s = await this.#s.start();
      return await this.#r.config.onSuccess?.(
        s,
        e,
        this.state.context,
        this,
        r
      ), await this.options.onSuccess?.(
        s,
        e,
        this.state.context,
        r
      ), await this.#r.config.onSettled?.(
        s,
        null,
        this.state.variables,
        this.state.context,
        this,
        r
      ), await this.options.onSettled?.(
        s,
        null,
        e,
        this.state.context,
        r
      ), this.#n({ type: "success", data: s }), s;
    } catch (s) {
      try {
        await this.#r.config.onError?.(
          s,
          e,
          this.state.context,
          this,
          r
        );
      } catch (a) {
        Promise.reject(a);
      }
      try {
        await this.options.onError?.(
          s,
          e,
          this.state.context,
          r
        );
      } catch (a) {
        Promise.reject(a);
      }
      try {
        await this.#r.config.onSettled?.(
          void 0,
          s,
          this.state.variables,
          this.state.context,
          this,
          r
        );
      } catch (a) {
        Promise.reject(a);
      }
      try {
        await this.options.onSettled?.(
          void 0,
          s,
          e,
          this.state.context,
          r
        );
      } catch (a) {
        Promise.reject(a);
      }
      throw this.#n({ type: "error", error: s }), s;
    } finally {
      this.#r.runNext(this);
    }
  }
  #n(e) {
    const t = (r) => {
      switch (e.type) {
        case "failed":
          return {
            ...r,
            failureCount: e.failureCount,
            failureReason: e.error
          };
        case "pause":
          return {
            ...r,
            isPaused: !0
          };
        case "continue":
          return {
            ...r,
            isPaused: !1
          };
        case "pending":
          return {
            ...r,
            context: e.context,
            data: void 0,
            failureCount: 0,
            failureReason: null,
            error: null,
            isPaused: e.isPaused,
            status: "pending",
            variables: e.variables,
            submittedAt: Date.now()
          };
        case "success":
          return {
            ...r,
            data: e.data,
            failureCount: 0,
            failureReason: null,
            error: null,
            status: "success",
            isPaused: !1
          };
        case "error":
          return {
            ...r,
            data: void 0,
            error: e.error,
            failureCount: r.failureCount + 1,
            failureReason: e.error,
            isPaused: !1,
            status: "error"
          };
      }
    };
    this.state = t(this.state), re.batch(() => {
      this.#t.forEach((r) => {
        r.onMutationUpdate(e);
      }), this.#r.notify({
        mutation: this,
        type: "updated",
        action: e
      });
    });
  }
};
function pi() {
  return {
    context: void 0,
    data: void 0,
    error: null,
    failureCount: 0,
    failureReason: null,
    isPaused: !1,
    status: "idle",
    variables: void 0,
    submittedAt: 0
  };
}
var gi = class extends nt {
  constructor(e = {}) {
    super(), this.config = e, this.#e = /* @__PURE__ */ new Set(), this.#t = /* @__PURE__ */ new Map(), this.#r = 0;
  }
  #e;
  #t;
  #r;
  build(e, t, r) {
    const n = new hi({
      client: e,
      mutationCache: this,
      mutationId: ++this.#r,
      options: e.defaultMutationOptions(t),
      state: r
    });
    return this.add(n), n;
  }
  add(e) {
    this.#e.add(e);
    const t = Qe(e);
    if (typeof t == "string") {
      const r = this.#t.get(t);
      r ? r.push(e) : this.#t.set(t, [e]);
    }
    this.notify({ type: "added", mutation: e });
  }
  remove(e) {
    if (this.#e.delete(e)) {
      const t = Qe(e);
      if (typeof t == "string") {
        const r = this.#t.get(t);
        if (r)
          if (r.length > 1) {
            const n = r.indexOf(e);
            n !== -1 && r.splice(n, 1);
          } else r[0] === e && this.#t.delete(t);
      }
    }
    this.notify({ type: "removed", mutation: e });
  }
  canRun(e) {
    const t = Qe(e);
    if (typeof t == "string") {
      const n = this.#t.get(t)?.find(
        (o) => o.state.status === "pending"
      );
      return !n || n === e;
    } else
      return !0;
  }
  runNext(e) {
    const t = Qe(e);
    return typeof t == "string" ? this.#t.get(t)?.find((n) => n !== e && n.state.isPaused)?.continue() ?? Promise.resolve() : Promise.resolve();
  }
  clear() {
    re.batch(() => {
      this.#e.forEach((e) => {
        this.notify({ type: "removed", mutation: e });
      }), this.#e.clear(), this.#t.clear();
    });
  }
  getAll() {
    return Array.from(this.#e);
  }
  find(e) {
    const t = { exact: !0, ...e };
    return this.getAll().find(
      (r) => Wt(t, r)
    );
  }
  findAll(e = {}) {
    return this.getAll().filter((t) => Wt(e, t));
  }
  notify(e) {
    re.batch(() => {
      this.listeners.forEach((t) => {
        t(e);
      });
    });
  }
  resumePausedMutations() {
    const e = this.getAll().filter((t) => t.state.isPaused);
    return re.batch(
      () => Promise.all(
        e.map((t) => t.continue().catch(le))
      )
    );
  }
};
function Qe(e) {
  return e.options.scope?.id;
}
var bi = class extends nt {
  constructor(e = {}) {
    super(), this.config = e, this.#e = /* @__PURE__ */ new Map();
  }
  #e;
  build(e, t, r) {
    const n = t.queryKey, o = t.queryHash ?? St(n, t);
    let s = this.get(o);
    return s || (s = new ui({
      client: e,
      queryKey: n,
      queryHash: o,
      options: e.defaultQueryOptions(t),
      state: r,
      defaultOptions: e.getQueryDefaults(n)
    }), this.add(s)), s;
  }
  add(e) {
    this.#e.has(e.queryHash) || (this.#e.set(e.queryHash, e), this.notify({
      type: "added",
      query: e
    }));
  }
  remove(e) {
    const t = this.#e.get(e.queryHash);
    t && (e.destroy(), t === e && this.#e.delete(e.queryHash), this.notify({ type: "removed", query: e }));
  }
  clear() {
    re.batch(() => {
      this.getAll().forEach((e) => {
        this.remove(e);
      });
    });
  }
  get(e) {
    return this.#e.get(e);
  }
  getAll() {
    return [...this.#e.values()];
  }
  find(e) {
    const t = { exact: !0, ...e };
    return this.getAll().find(
      (r) => jt(t, r)
    );
  }
  findAll(e = {}) {
    const t = this.getAll();
    return Object.keys(e).length > 0 ? t.filter((r) => jt(e, r)) : t;
  }
  notify(e) {
    re.batch(() => {
      this.listeners.forEach((t) => {
        t(e);
      });
    });
  }
  onFocus() {
    re.batch(() => {
      this.getAll().forEach((e) => {
        e.onFocus();
      });
    });
  }
  onOnline() {
    re.batch(() => {
      this.getAll().forEach((e) => {
        e.onOnline();
      });
    });
  }
}, mi = class {
  #e;
  #t;
  #r;
  #s;
  #n;
  #i;
  #a;
  #o;
  constructor(t = {}) {
    this.#e = t.queryCache || new bi(), this.#t = t.mutationCache || new gi(), this.#r = t.defaultOptions || {}, this.#s = /* @__PURE__ */ new Map(), this.#n = /* @__PURE__ */ new Map(), this.#i = 0;
  }
  mount() {
    this.#i++, this.#i === 1 && (this.#a = Cr.subscribe(async (t) => {
      t && (await this.resumePausedMutations(), this.#e.onFocus());
    }), this.#o = tt.subscribe(async (t) => {
      t && (await this.resumePausedMutations(), this.#e.onOnline());
    }));
  }
  unmount() {
    this.#i--, this.#i === 0 && (this.#a?.(), this.#a = void 0, this.#o?.(), this.#o = void 0);
  }
  isFetching(t) {
    return this.#e.findAll({ ...t, fetchStatus: "fetching" }).length;
  }
  isMutating(t) {
    return this.#t.findAll({ ...t, status: "pending" }).length;
  }
  /**
   * Imperative (non-reactive) way to retrieve data for a QueryKey.
   * Should only be used in callbacks or functions where reading the latest data is necessary, e.g. for optimistic updates.
   *
   * Hint: Do not use this function inside a component, because it won't receive updates.
   * Use `useQuery` to create a `QueryObserver` that subscribes to changes.
   */
  getQueryData(t) {
    const r = this.defaultQueryOptions({ queryKey: t });
    return this.#e.get(r.queryHash)?.state.data;
  }
  ensureQueryData(t) {
    const r = this.defaultQueryOptions(t), n = this.#e.build(this, r), o = n.state.data;
    return o === void 0 ? this.fetchQuery(t) : (t.revalidateIfStale && n.isStaleByTime(wt(r.staleTime, n)) && this.prefetchQuery(r), Promise.resolve(o));
  }
  getQueriesData(t) {
    return this.#e.findAll(t).map(({ queryKey: r, state: n }) => {
      const o = n.data;
      return [r, o];
    });
  }
  setQueryData(t, r, n) {
    const o = this.defaultQueryOptions({ queryKey: t }), a = this.#e.get(
      o.queryHash
    )?.state.data, i = Go(r, a);
    if (i !== void 0)
      return this.#e.build(this, o).setData(i, { ...n, manual: !0 });
  }
  setQueriesData(t, r, n) {
    return re.batch(
      () => this.#e.findAll(t).map(({ queryKey: o }) => [
        o,
        this.setQueryData(o, r, n)
      ])
    );
  }
  getQueryState(t) {
    const r = this.defaultQueryOptions({ queryKey: t });
    return this.#e.get(
      r.queryHash
    )?.state;
  }
  removeQueries(t) {
    const r = this.#e;
    re.batch(() => {
      r.findAll(t).forEach((n) => {
        r.remove(n);
      });
    });
  }
  resetQueries(t, r) {
    const n = this.#e;
    return re.batch(() => (n.findAll(t).forEach((o) => {
      o.reset();
    }), this.refetchQueries(
      {
        type: "active",
        ...t
      },
      r
    )));
  }
  cancelQueries(t, r = {}) {
    const n = { revert: !0, ...r }, o = re.batch(
      () => this.#e.findAll(t).map((s) => s.cancel(n))
    );
    return Promise.all(o).then(le).catch(le);
  }
  invalidateQueries(t, r = {}) {
    return re.batch(() => (this.#e.findAll(t).forEach((n) => {
      n.invalidate();
    }), t?.refetchType === "none" ? Promise.resolve() : this.refetchQueries(
      {
        ...t,
        type: t?.refetchType ?? t?.type ?? "active"
      },
      r
    )));
  }
  refetchQueries(t, r = {}) {
    const n = {
      ...r,
      cancelRefetch: r.cancelRefetch ?? !0
    }, o = re.batch(
      () => this.#e.findAll(t).filter((s) => !s.isDisabled() && !s.isStatic()).map((s) => {
        let a = s.fetch(void 0, n);
        return n.throwOnError || (a = a.catch(le)), s.state.fetchStatus === "paused" ? Promise.resolve() : a;
      })
    );
    return Promise.all(o).then(le);
  }
  fetchQuery(t) {
    const r = this.defaultQueryOptions(t);
    r.retry === void 0 && (r.retry = !1);
    const n = this.#e.build(this, r);
    return n.isStaleByTime(
      wt(r.staleTime, n)
    ) ? n.fetch(r) : Promise.resolve(n.state.data);
  }
  prefetchQuery(t) {
    return this.fetchQuery(t).then(le).catch(le);
  }
  fetchInfiniteQuery(t) {
    return t.behavior = Ut(t.pages), this.fetchQuery(t);
  }
  prefetchInfiniteQuery(t) {
    return this.fetchInfiniteQuery(t).then(le).catch(le);
  }
  ensureInfiniteQueryData(t) {
    return t.behavior = Ut(t.pages), this.ensureQueryData(t);
  }
  resumePausedMutations() {
    return tt.isOnline() ? this.#t.resumePausedMutations() : Promise.resolve();
  }
  getQueryCache() {
    return this.#e;
  }
  getMutationCache() {
    return this.#t;
  }
  getDefaultOptions() {
    return this.#r;
  }
  setDefaultOptions(t) {
    this.#r = t;
  }
  setQueryDefaults(t, r) {
    this.#s.set(qe(t), {
      queryKey: t,
      defaultOptions: r
    });
  }
  getQueryDefaults(t) {
    const r = [...this.#s.values()], n = {};
    return r.forEach((o) => {
      Fe(t, o.queryKey) && Object.assign(n, o.defaultOptions);
    }), n;
  }
  setMutationDefaults(t, r) {
    this.#n.set(qe(t), {
      mutationKey: t,
      defaultOptions: r
    });
  }
  getMutationDefaults(t) {
    const r = [...this.#n.values()], n = {};
    return r.forEach((o) => {
      Fe(t, o.mutationKey) && Object.assign(n, o.defaultOptions);
    }), n;
  }
  defaultQueryOptions(t) {
    if (t._defaulted)
      return t;
    const r = {
      ...this.#r.queries,
      ...this.getQueryDefaults(t.queryKey),
      ...t,
      _defaulted: !0
    };
    return r.queryHash || (r.queryHash = St(
      r.queryKey,
      r
    )), r.refetchOnReconnect === void 0 && (r.refetchOnReconnect = r.networkMode !== "always"), r.throwOnError === void 0 && (r.throwOnError = !!r.suspense), !r.networkMode && r.persister && (r.networkMode = "offlineFirst"), r.queryFn === et && (r.enabled = !1), r;
  }
  defaultMutationOptions(t) {
    return t?._defaulted ? t : {
      ...this.#r.mutations,
      ...t?.mutationKey && this.getMutationDefaults(t.mutationKey),
      ...t,
      _defaulted: !0
    };
  }
  clear() {
    this.#e.clear(), this.#t.clear();
  }
}, wi = nr(void 0), vi = (e) => (T((t) => (t?.(), e.client.mount(), e.client.unmount.bind(e.client))), De(() => e.client.unmount()), w(wi.Provider, {
  value: () => e.client,
  get children() {
    return e.children;
  }
})), xi = class extends mi {
  constructor(e = {}) {
    super(e);
  }
};
const yi = new xi({
  defaultOptions: {
    queries: {
      staleTime: 5e3,
      refetchOnWindowFocus: !1
    }
  }
});
function $i(e) {
  return w(vi, {
    client: yi,
    get children() {
      return e.children;
    }
  });
}
class ki {
  _state;
  listeners = /* @__PURE__ */ new Set();
  transport;
  abortController;
  constructor(t) {
    this._state = {
      messages: [],
      isStreaming: !1,
      streamingMessage: null,
      ...t.initialState
    }, this.transport = t.transport;
  }
  get state() {
    return this._state;
  }
  subscribe(t) {
    return this.listeners.add(t), t(this._state), () => this.listeners.delete(t);
  }
  appendMessage(t) {
    this.patch({ messages: [...this._state.messages, t] });
  }
  replaceMessages(t) {
    this.patch({ messages: [...t] });
  }
  clearMessages() {
    this.patch({ messages: [] });
  }
  abort() {
    this.abortController?.abort();
  }
  async send(t, r) {
    console.log("[ChatAgent] send() called with text:", t);
    const n = {
      role: "user",
      content: t,
      attachments: r,
      timestamp: Date.now()
    };
    this.appendMessage(n), console.log("[ChatAgent] User message appended, total messages:", this._state.messages.length), this.abortController = new AbortController(), this.patch({ isStreaming: !0, streamingMessage: null, error: void 0 });
    try {
      for await (const o of this.transport.run(
        this._state.messages,
        n,
        {},
        this.abortController.signal
      ))
        if (this.handleEvent(o), o.type === "agent_end") break;
    } catch (o) {
      this.patch({ error: o instanceof Error ? o.message : String(o) });
    } finally {
      this.patch({ isStreaming: !1, streamingMessage: null }), this.abortController = void 0;
    }
  }
  handleEvent(t) {
    switch (t.type) {
      case "message_start":
      case "message_update":
        this.patch({ streamingMessage: t.message });
        break;
      case "message_end":
        t.message.role !== "user" && this.appendMessage(t.message), this.patch({ streamingMessage: null });
        break;
    }
  }
  patch(t) {
    this._state = { ...this._state, ...t };
    for (const r of this.listeners)
      r(this._state);
  }
}
class Si {
  queue = [];
  resolvers = [];
  closed = !1;
  push(t) {
    if (this.closed) return;
    const r = this.resolvers.shift();
    r ? r({
      value: t,
      done: !1
    }) : this.queue.push(t);
  }
  close() {
    for (this.closed = !0; this.resolvers.length; ) {
      const t = this.resolvers.shift();
      t && t({
        value: void 0,
        done: !0
      });
    }
  }
  get length() {
    return this.queue.length;
  }
  get isClosed() {
    return this.closed;
  }
  async *iterator(t) {
    for (; ; ) {
      if (t?.aborted) return;
      if (this.queue.length > 0) {
        yield this.queue.shift();
        continue;
      }
      if (this.closed) return;
      const r = await new Promise((n) => {
        this.resolvers.push(n);
      });
      if (r.done) return;
      yield r.value;
    }
  }
}
class _i {
  queues = /* @__PURE__ */ new Map();
  get(t) {
    const r = this.queues.get(t);
    if (r) return r;
    const n = new Si();
    return this.queues.set(t, n), n;
  }
  push(t, r) {
    const n = this.get(t);
    n.push(r), r.type === "agent_end" && n.close();
  }
  async *consume(t, r) {
    const n = this.get(t);
    try {
      for await (const o of n.iterator(r))
        yield o;
    } finally {
      n.isClosed && n.length === 0 && this.queues.delete(t);
    }
  }
}
let B;
const Oe = new _i();
function X() {
  return B;
}
class Or {
  sessionId;
  constructor(t) {
    this.sessionId = t;
  }
  async *run(t, r, n, o) {
    const s = typeof r.content == "string" ? r.content : Array.isArray(r.content) ? r.content.filter((c) => c.type === "text").map((c) => c.text).join("") : "", a = r.attachments, {
      runId: i
    } = await B.request.sendChatMessage({
      sessionId: this.sessionId,
      text: s,
      attachments: a
    }), l = Oe.get(i);
    o && o.addEventListener("abort", () => {
      B.request.abortChatRun({
        sessionId: this.sessionId,
        runId: i
      }).catch(() => {
      }), l.close();
    });
    for await (const c of Oe.consume(i, o))
      if (yield c, c.type === "agent_end") break;
  }
  async *continue(t, r, n) {
    const {
      runId: o
    } = await B.request.sendChatMessage({
      sessionId: this.sessionId,
      text: ""
    }), s = Oe.get(o);
    n && n.addEventListener("abort", () => {
      B.request.abortChatRun({
        sessionId: this.sessionId,
        runId: o
      }).catch(() => {
      }), s.close();
    });
    for await (const a of Oe.consume(o, n))
      if (yield a, a.type === "agent_end") break;
  }
}
async function Ci() {
  const [e, t] = await Promise.all([B.request.getSettings({}), B.request.getSecretStatus({})]);
  E({
    settings: e,
    secretStatus: t,
    inspectorOpen: e.ui.workflowPanel.isOpen
  });
  const r = await B.request.listChatSessions({});
  E("sessions", r);
  let n;
  if (r.length > 0)
    n = r[0].sessionId;
  else {
    n = (await B.request.createChatSession({
      title: "New Session"
    })).sessionId;
    const i = await B.request.listChatSessions({});
    E("sessions", i);
  }
  await _t(n);
  const o = await B.request.getWorkspaceState({});
  E({
    workspaceRoot: o.root,
    workflows: o.workflows
  });
  const s = await B.request.listRuns({
    status: "all"
  });
  E("runs", o.root ? s.filter((a) => a.workspaceRoot === o.root) : s);
}
async function _t(e) {
  E("sessionId", e);
  const t = await B.request.getChatSession({
    sessionId: e
  }), r = new Or(e), n = new ki({
    transport: r,
    initialState: {
      messages: t.messages ?? []
    }
  });
  E("agent", n);
}
async function Pr(e) {
  await _t(e);
}
async function Tr() {
  const e = await B.request.createChatSession({
    title: "New Session"
  }), t = await B.request.listChatSessions({});
  E("sessions", t), await _t(e.sessionId);
}
async function ce() {
  const e = await B.request.listRuns({
    status: "all"
  }), t = $.workspaceRoot;
  E("runs", t ? e.filter((r) => r.workspaceRoot === t) : e);
}
async function ue(e) {
  E({
    selectedRunId: e,
    contextRunId: e,
    inspectorOpen: !0
  });
  const t = await B.request.getRun({
    runId: e
  });
  E("runDetails", e, t);
  const r = await B.request.getRunEvents({
    runId: e,
    afterSeq: -1
  });
  E("runEvents", e, r.events), E("runEventSeq", e, r.lastSeq);
  try {
    const n = await B.request.getFrame({
      runId: e
    });
    E("frames", e, n);
  } catch {
  }
  try {
    const n = await B.request.getRunOutputs({
      runId: e
    });
    E("outputs", e, n);
  } catch {
  }
  try {
    const n = await B.request.getRunAttempts({
      runId: e
    });
    E("attempts", e, n);
  } catch {
  }
}
function Er(e) {
  B = e({
    requests: {},
    messages: {
      agentEvent: (r) => {
        Oe.push(r.runId, r.event);
      },
      chatMessage: ({
        sessionId: r,
        message: n
      }) => {
        r === $.sessionId && $.agent && $.agent.appendMessage(n);
      },
      workflowEvent: (r) => {
        const n = r.runId;
        E("runEvents", n, (o) => [...o ?? [], r]), E("runEventSeq", n, r.seq), ce();
      },
      workflowFrame: (r) => {
        E("frames", r.runId, r);
      },
      workspaceState: (r) => {
        E({
          workspaceRoot: r.root,
          workflows: r.workflows
        }), ce();
      },
      toast: (r) => {
        se(r.level, r.message);
      }
    }
  });
  const t = document.getElementById("app") ?? document.body;
  sn(() => w(Ho, {
    client: B,
    get children() {
      return w($i, {
        get children() {
          return w(zo, {});
        }
      });
    }
  }), t), Ci().catch((r) => {
    console.error("Bootstrap failed:", r), se("error", `Bootstrap failed: ${r?.message ?? r}`);
  });
}
const Gt = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  BunAgentTransport: Or,
  createNewSession: Tr,
  focusRun: ue,
  getRpc: X,
  refreshRuns: ce,
  startApp: Er,
  switchSession: Pr
}, Symbol.toStringTag, { value: "Module" })), Ii = 1e10, Ai = 1e3;
function He(e, t) {
  const r = e.map((n) => `"${n}"`).join(", ");
  return new Error(`This RPC instance cannot ${t} because the transport did not provide one or more of these methods: ${r}`);
}
function Ri(e = {}) {
  let t = {};
  function r(k) {
    t = k;
  }
  let n = {};
  function o(k) {
    n.unregisterHandler && n.unregisterHandler(), n = k, n.registerHandler?.(F);
  }
  let s;
  function a(k) {
    if (typeof k == "function") {
      s = k;
      return;
    }
    s = (v, O) => {
      const C = k[v];
      if (C)
        return C(O);
      const A = k._;
      if (!A)
        throw new Error(`The requested method has no handler: ${v}`);
      return A(v, O);
    };
  }
  const { maxRequestTime: i = Ai } = e;
  e.transport && o(e.transport), e.requestHandler && a(e.requestHandler), e._debugHooks && r(e._debugHooks);
  let l = 0;
  function c() {
    return l <= Ii ? ++l : l = 0;
  }
  const d = /* @__PURE__ */ new Map(), u = /* @__PURE__ */ new Map();
  function h(k, ...v) {
    const O = v[0];
    return new Promise((C, A) => {
      if (!n.send)
        throw He(["send"], "make requests");
      const D = c(), N = {
        type: "request",
        id: D,
        method: k,
        params: O
      };
      d.set(D, { resolve: C, reject: A }), i !== 1 / 0 && u.set(D, setTimeout(() => {
        u.delete(D), A(new Error("RPC request timed out."));
      }, i)), t.onSend?.(N), n.send(N);
    });
  }
  const g = new Proxy(h, {
    get: (k, v, O) => v in k ? Reflect.get(k, v, O) : (C) => h(v, C)
  }), m = g;
  function p(k, ...v) {
    const O = v[0];
    if (!n.send)
      throw He(["send"], "send messages");
    const C = {
      type: "message",
      id: k,
      payload: O
    };
    t.onSend?.(C), n.send(C);
  }
  const b = new Proxy(p, {
    get: (k, v, O) => v in k ? Reflect.get(k, v, O) : (C) => p(v, C)
  }), _ = b, y = /* @__PURE__ */ new Map(), I = /* @__PURE__ */ new Set();
  function x(k, v) {
    if (!n.registerHandler)
      throw He(["registerHandler"], "register message listeners");
    if (k === "*") {
      I.add(v);
      return;
    }
    y.has(k) || y.set(k, /* @__PURE__ */ new Set()), y.get(k)?.add(v);
  }
  function R(k, v) {
    if (k === "*") {
      I.delete(v);
      return;
    }
    y.get(k)?.delete(v), y.get(k)?.size === 0 && y.delete(k);
  }
  async function F(k) {
    if (t.onReceive?.(k), !("type" in k))
      throw new Error("Message does not contain a type.");
    if (k.type === "request") {
      if (!n.send || !s)
        throw He(["send", "requestHandler"], "handle requests");
      const { id: v, method: O, params: C } = k;
      let A;
      try {
        A = {
          type: "response",
          id: v,
          success: !0,
          payload: await s(O, C)
        };
      } catch (D) {
        if (!(D instanceof Error))
          throw D;
        A = {
          type: "response",
          id: v,
          success: !1,
          error: D.message
        };
      }
      t.onSend?.(A), n.send(A);
      return;
    }
    if (k.type === "response") {
      const v = u.get(k.id);
      v != null && clearTimeout(v);
      const { resolve: O, reject: C } = d.get(k.id) ?? {};
      k.success ? O?.(k.payload) : C?.(new Error(k.error));
      return;
    }
    if (k.type === "message") {
      for (const O of I)
        O(k.id, k.payload);
      const v = y.get(k.id);
      if (!v)
        return;
      for (const O of v)
        O(k.payload);
      return;
    }
    throw new Error(`Unexpected RPC message type: ${k.type}`);
  }
  return {
    setTransport: o,
    setRequestHandler: a,
    request: g,
    requestProxy: m,
    send: b,
    sendProxy: _,
    addMessageListener: x,
    removeMessageListener: R,
    proxy: { send: _, request: m },
    _setDebugHooks: r
  };
}
function Vt(e) {
  return Ri(e);
}
const Oi = (e, t, r) => {
  class n extends HTMLElement {
    constructor() {
      super(), this.maskSelectors = /* @__PURE__ */ new Set(), this.lastRect = {
        x: 0,
        y: 0,
        width: 0,
        height: 0
      }, this.lastMasksJSON = "", this.lastMasks = [], this.transparent = !1, this.passthroughEnabled = !1, this.hidden = !1, this.hiddenMirrorMode = !1, this.wasZeroRect = !1, this.isMirroring = !1, this.masks = "", this.partition = null, this.asyncResolvers = {}, this.boundSyncDimensions = () => this.syncDimensions(), this.boundForceSyncDimensions = () => this.syncDimensions(!0), this.internalRpc = t, this.bunRpc = r, requestAnimationFrame(() => {
        this.initWebview();
      });
    }
    addMaskSelector(s) {
      this.maskSelectors.add(s), this.syncDimensions();
    }
    removeMaskSelector(s) {
      this.maskSelectors.delete(s), this.syncDimensions();
    }
    async initWebview() {
      const s = this.getBoundingClientRect();
      this.lastRect = s;
      const a = this.src || this.getAttribute("src"), i = this.html || this.getAttribute("html"), l = this.masks || this.getAttribute("masks");
      l && l.split(",").forEach((d) => {
        this.maskSelectors.add(d);
      });
      const c = await this.internalRpc.request.webviewTagInit({
        hostWebviewId: window.__electrobunWebviewId,
        windowId: window.__electrobunWindowId,
        renderer: this.renderer,
        url: a,
        html: i,
        preload: this.preload || this.getAttribute("preload") || null,
        partition: this.partition || this.getAttribute("partition") || null,
        frame: {
          width: s.width,
          height: s.height,
          x: s.x,
          y: s.y
        },
        // todo: wire up to a param and a method to update them
        navigationRules: null
      });
      console.log("electrobun webviewid: ", c), this.webviewId = c, this.id = `electrobun-webview-${c}`, this.setAttribute("id", this.id);
    }
    callAsyncJavaScript({ script: s }) {
      return new Promise((a, i) => {
        const l = "" + Date.now() + Math.random();
        this.asyncResolvers[l] = {
          resolve: a,
          reject: i
        }, this.internalRpc.request.webviewTagCallAsyncJavaScript({
          messageId: l,
          webviewId: this.webviewId,
          hostWebviewId: window.__electrobunWebviewId,
          script: s
        });
      });
    }
    setCallAsyncJavaScriptResponse(s, a) {
      const i = this.asyncResolvers[s];
      delete this.asyncResolvers[s];
      try {
        a = JSON.parse(a), a.result ? i.resolve(a.result) : i.reject(a.error);
      } catch (l) {
        i.reject(l.message);
      }
    }
    async canGoBack() {
      return this.internalRpc.request.webviewTagCanGoBack({ id: this.webviewId });
    }
    async canGoForward() {
      return this.internalRpc.request.webviewTagCanGoForward({
        id: this.webviewId
      });
    }
    // propertie setters/getters. keeps them in sync with dom attributes
    updateAttr(s, a) {
      a ? this.setAttribute(s, a) : this.removeAttribute(s);
    }
    get src() {
      return this.getAttribute("src");
    }
    set src(s) {
      this.updateAttr("src", s);
    }
    get html() {
      return this.getAttribute("html");
    }
    set html(s) {
      this.updateAttr("html", s);
    }
    get preload() {
      return this.getAttribute("preload");
    }
    set preload(s) {
      this.updateAttr("preload", s);
    }
    get renderer() {
      return this.getAttribute("renderer") === "cef" ? "cef" : "native";
    }
    set renderer(s) {
      const a = s === "cef" ? "cef" : "native";
      this.updateAttr("renderer", a);
    }
    // Note: since <electrobun-webview> is an anchor for a native webview
    // on osx even if we hide it, enable mouse passthrough etc. There
    // are still events like drag events which are natively handled deep in the window manager
    // and will be handled incorrectly. To get around this for now we need to
    // move the webview off screen during delegate mode.
    adjustDimensionsForHiddenMirrorMode(s) {
      return this.hiddenMirrorMode && (s.x = 0 - s.width), s;
    }
    // Note: in the brwoser-context we can ride on the dom element's uilt in event emitter for managing custom events
    on(s, a) {
      this.addEventListener(s, a);
    }
    off(s, a) {
      this.removeEventListener(s, a);
    }
    // This is typically called by injected js from bun
    emit(s, a) {
      this.dispatchEvent(new CustomEvent(s, { detail: a }));
    }
    // Call this via document.querySelector('electrobun-webview').syncDimensions();
    // That way the host can trigger an alignment with the nested webview when they
    // know that they're chaning something in order to eliminate the lag that the
    // catch all loop will catch
    syncDimensions(s = !1) {
      if (!this.webviewId || !s && this.hidden)
        return;
      const a = this.getBoundingClientRect(), { x: i, y: l, width: c, height: d } = this.adjustDimensionsForHiddenMirrorMode(a), u = this.lastRect;
      if (c === 0 && d === 0) {
        this.wasZeroRect === !1 && (console.log("WAS NOT ZERO RECT", this.webviewId), this.wasZeroRect = !0, this.toggleTransparent(!0, !0), this.togglePassthrough(!0, !0));
        return;
      }
      const h = [];
      this.maskSelectors.forEach((m) => {
        const p = document.querySelectorAll(m);
        for (let b = 0; b < p.length; b++) {
          const _ = p[b];
          if (_) {
            const y = _.getBoundingClientRect();
            h.push({
              // reposition the bounding rect to be relative to the webview rect
              // so objc can apply the mask correctly and handle the actual overlap
              x: y.x - i,
              y: y.y - l,
              width: y.width,
              height: y.height
            });
          }
        }
      });
      const g = h.length ? JSON.stringify(h) : "";
      (s || u.x !== i || u.y !== l || u.width !== c || u.height !== d || this.lastMasksJSON !== g) && (this.setPositionCheckLoop(!0), this.lastRect = a, this.lastMasks = h, this.lastMasksJSON = g, this.internalRpc.send.webviewTagResize({
        id: this.webviewId,
        frame: {
          width: c,
          height: d,
          x: i,
          y: l
        },
        masks: g
      })), this.wasZeroRect && (this.wasZeroRect = !1, console.log("WAS ZERO RECT", this.webviewId), this.toggleTransparent(!1, !0), this.togglePassthrough(!1, !0));
    }
    setPositionCheckLoop(s = !1) {
      this.positionCheckLoop && (clearInterval(this.positionCheckLoop), this.positionCheckLoop = void 0), this.positionCheckLoopReset && (clearTimeout(this.positionCheckLoopReset), this.positionCheckLoopReset = void 0);
      const a = s ? 0 : 300;
      s && (this.positionCheckLoopReset = setTimeout(() => {
        this.setPositionCheckLoop(!1);
      }, 2e3)), this.positionCheckLoop = setInterval(() => this.syncDimensions(), a);
    }
    connectedCallback() {
      this.setPositionCheckLoop(), this.resizeObserver = new ResizeObserver(() => {
        this.syncDimensions();
      }), window.addEventListener("resize", this.boundForceSyncDimensions), window.addEventListener("scroll", this.boundSyncDimensions);
    }
    disconnectedCallback() {
      clearInterval(this.positionCheckLoop), this.resizeObserver?.disconnect(), window.removeEventListener("resize", this.boundForceSyncDimensions), window.removeEventListener("scroll", this.boundSyncDimensions), this.webviewId && (this.internalRpc.send.webviewTagRemove({ id: this.webviewId }), this.webviewId = void 0);
    }
    static get observedAttributes() {
      return ["src", "html", "preload", "class", "style"];
    }
    attributeChangedCallback(s, a, i) {
      s === "src" && a !== i ? this.updateIFrameSrc(i) : s === "html" && a !== i ? this.updateIFrameHtml(i) : s === "preload" && a !== i ? this.updateIFramePreload(i) : this.syncDimensions();
    }
    updateIFrameSrc(s) {
      if (!this.webviewId) {
        console.warn("updateIFrameSrc called on removed webview");
        return;
      }
      this.internalRpc.send.webviewTagUpdateSrc({
        id: this.webviewId,
        url: s
      });
    }
    updateIFrameHtml(s) {
      if (!this.webviewId) {
        console.warn("updateIFrameHtml called on removed webview");
        return;
      }
      this.internalRpc.send.webviewTagUpdateHtml({
        id: this.webviewId,
        html: s
      });
    }
    updateIFramePreload(s) {
      if (!this.webviewId) {
        console.warn("updateIFramePreload called on removed webview");
        return;
      }
      this.internalRpc.send.webviewTagUpdatePreload({
        id: this.webviewId,
        preload: s
      });
    }
    goBack() {
      if (!this.webviewId) {
        console.warn("goBack called on removed webview");
        return;
      }
      this.internalRpc.send.webviewTagGoBack({ id: this.webviewId });
    }
    goForward() {
      if (!this.webviewId) {
        console.warn("goForward called on removed webview");
        return;
      }
      this.internalRpc.send.webviewTagGoForward({ id: this.webviewId });
    }
    reload() {
      if (!this.webviewId) {
        console.warn("reload called on removed webview");
        return;
      }
      this.internalRpc.send.webviewTagReload({ id: this.webviewId });
    }
    loadURL(s) {
      if (!this.webviewId) {
        console.warn("loadURL called on removed webview");
        return;
      }
      this.setAttribute("src", s), this.internalRpc.send.webviewTagUpdateSrc({
        id: this.webviewId,
        url: s
      });
    }
    loadHTML(s) {
      if (!this.webviewId) {
        console.warn("loadHTML called on removed webview");
        return;
      }
      this.setAttribute("html", s), this.internalRpc.send.webviewTagUpdateHtml({
        id: this.webviewId,
        html: s
      });
    }
    // This sets the native webview hovering over the dom to be transparent
    toggleTransparent(s, a) {
      if (!this.webviewId) {
        console.warn("toggleTransparent called on removed webview");
        return;
      }
      let i;
      typeof s > "u" ? i = !this.transparent : i = !!s, a || (this.transparent = i), this.internalRpc.send.webviewTagSetTransparent({
        id: this.webviewId,
        transparent: i
      });
    }
    togglePassthrough(s, a) {
      if (!this.webviewId) {
        console.warn("togglePassthrough called on removed webview");
        return;
      }
      let i;
      typeof s > "u" ? i = !this.passthroughEnabled : i = !!s, a || (this.passthroughEnabled = i), this.internalRpc.send.webviewTagSetPassthrough({
        id: this.webviewId,
        enablePassthrough: this.passthroughEnabled || !!s
      });
    }
    toggleHidden(s, a) {
      if (!this.webviewId) {
        console.warn("toggleHidden called on removed webview");
        return;
      }
      let i;
      typeof s > "u" ? i = !this.hidden : i = !!s, a || (this.hidden = i), console.trace("electrobun toggle hidden: ", this.hidden, this.webviewId), this.internalRpc.send.webviewTagSetHidden({
        id: this.webviewId,
        hidden: this.hidden || !!s
      });
    }
  }
  customElements.define("electrobun-webview", n), Pi();
}, Pi = () => {
  var e = document.createElement("style");
  e.type = "text/css";
  var t = `
electrobun-webview {
    display: block;
    width: 800px;
    height: 300px;
    background: #fff;
    background-repeat: no-repeat!important;   
    overflow: hidden; 
}
`;
  e.appendChild(document.createTextNode(t));
  var r = document.getElementsByTagName("head")[0];
  r && (r.firstChild ? r.insertBefore(e, r.firstChild) : r.appendChild(e));
}, Jt = (e) => e.target?.classList.contains("electrobun-webkit-app-region-drag"), Zt = window.__electrobunWebviewId, Xt = window.__electrobunWindowId, Ti = window.__electrobunRpcSocketPort;
class Yt {
  constructor(t) {
    this.isProcessingQueue = !1, this.sendToInternalQueue = [], this.rpc = t.rpc, this.init();
  }
  init() {
    this.initInternalRpc(), this.initSocketToBun(), Oi(!0, this.internalRpc, this.rpc), this.initElectrobunListeners(), window.__electrobun = {
      receiveMessageFromBun: this.receiveMessageFromBun.bind(this),
      receiveInternalMessageFromBun: this.receiveInternalMessageFromBun.bind(this)
    }, this.rpc && this.rpc.setTransport(this.createTransport());
  }
  initInternalRpc() {
    this.internalRpc = Vt({
      transport: this.createInternalTransport(),
      // requestHandler: {
      // },
      maxRequestTime: 1e3
    });
  }
  initSocketToBun() {
    const t = new WebSocket(
      `ws://localhost:${Ti}/socket?webviewId=${Zt}`
    );
    this.bunSocket = t, t.addEventListener("open", () => {
    }), t.addEventListener("message", async (r) => {
      const n = r.data;
      if (typeof n == "string")
        try {
          const o = JSON.parse(n), s = await window.__electrobun_decrypt(
            o.encryptedData,
            o.iv,
            o.tag
          );
          this.rpcHandler?.(JSON.parse(s));
        } catch (o) {
          console.error("Error parsing bun message:", o);
        }
      else n instanceof Blob || console.error("UNKNOWN DATA TYPE RECEIVED:", r.data);
    }), t.addEventListener("error", (r) => {
      console.error("Socket error:", r);
    }), t.addEventListener("close", (r) => {
    });
  }
  // This will be attached to the global object, bun can rpc reply by executingJavascript
  // of that global reference to the function
  receiveInternalMessageFromBun(t) {
    this.internalRpcHandler && this.internalRpcHandler(t);
  }
  sendToBunInternal(t) {
    try {
      const r = JSON.stringify(t);
      this.sendToInternalQueue.push(r), this.processQueue();
    } catch (r) {
      console.error("failed to send to bun internal", r);
    }
  }
  processQueue() {
    const t = this;
    if (t.isProcessingQueue) {
      setTimeout(() => {
        t.processQueue();
      });
      return;
    }
    if (t.sendToInternalQueue.length === 0)
      return;
    t.isProcessingQueue = !0;
    const r = JSON.stringify(t.sendToInternalQueue);
    t.sendToInternalQueue = [], window.__electrobunInternalBridge?.postMessage(r), setTimeout(() => {
      t.isProcessingQueue = !1;
    }, 2);
  }
  initElectrobunListeners() {
    document.addEventListener("mousedown", (t) => {
      Jt(t) && this.internalRpc?.send.startWindowMove({ id: Xt });
    }), document.addEventListener("mouseup", (t) => {
      Jt(t) && this.internalRpc?.send.stopWindowMove({ id: Xt });
    });
  }
  createTransport() {
    const t = this;
    return {
      send(r) {
        try {
          const n = JSON.stringify(r);
          t.bunBridge(n);
        } catch (n) {
          console.error("bun: failed to serialize message to webview", n);
        }
      },
      registerHandler(r) {
        t.rpcHandler = r;
      }
    };
  }
  createInternalTransport() {
    const t = this;
    return {
      send(r) {
        r.hostWebviewId = Zt, t.sendToBunInternal(r);
      },
      registerHandler(r) {
        t.internalRpcHandler = r;
      }
    };
  }
  async bunBridge(t) {
    if (this.bunSocket?.readyState === WebSocket.OPEN)
      try {
        const { encryptedData: r, iv: n, tag: o } = await window.__electrobun_encrypt(
          t
        ), a = JSON.stringify({
          encryptedData: r,
          iv: n,
          tag: o
        });
        this.bunSocket.send(a);
        return;
      } catch (r) {
        console.error("Error sending message to bun via socket:", r);
      }
    window.__electrobunBunBridge?.postMessage(t);
  }
  receiveMessageFromBun(t) {
    this.rpcHandler && this.rpcHandler(t);
  }
  // todo (yoav): This is mostly just the reverse of the one in BrowserView.ts on the bun side. Should DRY this up.
  static defineRPC(t) {
    const r = {
      requests: {
        evaluateJavascriptWithResponse: ({ script: a }) => new Promise((i) => {
          try {
            const c = new Function(a)();
            c instanceof Promise ? c.then((d) => {
              i(d);
            }).catch((d) => {
              console.error("bun: async script execution failed", d), i(String(d));
            }) : i(c);
          } catch (l) {
            console.error("bun: failed to eval script", l), i(String(l));
          }
        })
      }
    }, n = {
      maxRequestTime: t.maxRequestTime,
      requestHandler: {
        ...t.handlers.requests,
        ...r.requests
      },
      transport: {
        // Note: RPC Anywhere will throw if you try add a message listener if transport.registerHandler is falsey
        registerHandler: () => {
        }
      }
    }, o = Vt(n), s = t.handlers.messages;
    return s && o.addMessageListener(
      "*",
      (a, i) => {
        const l = s["*"];
        l && l(a, i);
        const c = s[a];
        c && c(i);
      }
    ), o;
  }
}
const Ei = (e) => {
  const t = Yt.defineRPC({ handlers: e, maxRequestTime: 3e5 });
  return new Yt({ rpc: t }), t;
};
Er(Ei);
