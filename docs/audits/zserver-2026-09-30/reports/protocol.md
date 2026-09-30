# Protocol / byte-fidelity / broker forwarding audit (snapshot 4cfa1d3)

Auditor perspective: wire protocol + byte fidelity + broker forwarding semantics.
Snapshot: /tmp/zacp-snap-4cfa1d3 (read-only). Experiments: /tmp/audit-proto-* (cleaned at end).
Node: v22.22.3

(Sections are appended incrementally as each focus item completes; final message repeats the full report.)


---
## Byte Experiments

### E1a. validateClientHeader with prototype-chain channel names (unit, dist/backend/zserver/broker.js)
Input: `validateClientHeader([type, 1, ch, "x"])` for type in {100,102}, ch in every own property name of `Object.prototype` plus controls.
Output (identical for 100 and 102): THROWS `TypeError: table[channel]?.has is not a function` for exactly these 12 names:
`constructor, __defineGetter__, __defineSetter__, hasOwnProperty, __lookupGetter__, __lookupSetter__, isPrototypeOf, propertyIsEnumerable, toString, valueOf, __proto__, toLocaleString`.
Controls (`zcode-agent`, `nope`, `""`, `"hasOwnProperty "`, `"toString\0"`) return `{ok:false,...}` normally.
Root cause fact: `BROKER_ALLOWED_CALLS` / `BROKER_ALLOWED_EVENTS` are plain object literals: `Object.getPrototypeOf(x) === Object.prototype` -> true, `Object.isFrozen(x)` -> false.
Why `?.` does not save it: `table["constructor"]` is `Object` (a function, not nullish) so `?.has` proceeds to read `Object.has` -> `undefined`, then `undefined(name)` -> TypeError. `table["__proto__"]` is `Object.prototype` (object, non-nullish) whose `.has` is undefined -> same TypeError. `?.` only guards nullish `table[channel]`.

### E1b. Live broker process, single hostile frame
Setup: real `ZServerBroker` in its own `node` child (no unhandledRejection handler, same as `zcode-acp zserver-broker` path in src/cli.ts:153-176), fixture as serverRoot, one bystander client with an open EventListen (id 6, 9->11 events received) plus a healthy call round-trip, then a second raw client sends ONE frame `encodeFrame(encodeMessage([100,1,"constructor","x"], undefined))` (also run with "__proto__").
Output: broker process `exit {code:1, signal:null}` **6 ms** after the frame; stderr shows
```
file:///.../dist/backend/zserver/broker.js:93
    if (!table[channel]?.has(name)) {
TypeError: table[channel]?.has is not a function
    at validateClientHeader (broker.js:93:26)
    at ZServerBroker.routeClientFrame (broker.js:334:25)
    at process.processTicksAndRejections
```
Bystander socket closed 6 ms later; attacker socket closed; socket FILE remains on disk (stale, `existsSync` true — `stop()` never ran, so `unlinkSync` never happens); the fixture server child was reaped by the watchdog within 6 s (no orphan).
