import React, { useId, useState } from "react";

export function Field({ label, hint, children }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
export function Toggle({ label, hint, checked, onChange, testid }) {
  const id = useId();
  return (
    <div className="field field-row">
      <label htmlFor={id} className="field-label">{label}</label>
      <input id={id} type="checkbox" role="switch" checked={!!checked} onChange={(e) => onChange(e.target.checked)} data-testid={testid} />
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
export function Slider({ label, hint, value, min, max, step = 0.01, onChange, unit = "", testid }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">{label} <output>{Number(value).toFixed(step < 0.1 ? 2 : 0)}{unit}</output></label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} data-testid={testid} />
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
export function Select({ label, hint, value, options, onChange, testid }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testid}>
        {options.map((o) => (typeof o === "string" ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
export function Text({ label, hint, value, onChange, multiline = false, rows = 4, maxLength, placeholder, testid, list }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">{label}</label>
      {multiline ? (
        <textarea id={id} rows={rows} value={value} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} data-testid={testid} />
      ) : (
        <input id={id} type="text" value={value} maxLength={maxLength} placeholder={placeholder} list={list} onChange={(e) => onChange(e.target.value)} data-testid={testid} />
      )}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
export function Color({ label, value, onChange, testid }) {
  const id = useId();
  return (
    <div className="field field-row">
      <label htmlFor={id} className="field-label">{label}</label>
      <input id={id} type="color" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testid} />
      <code>{value}</code>
    </div>
  );
}
/** Editable list of short texts (topics). Enter adds; each chip has a remove button. */
export function Tags({ label, hint, value, onChange, placeholder, testid }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft("");
  };
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <ul className="tags">
        {value.map((t) => (
          <li key={t}>
            {t}
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>×</button>
          </li>
        ))}
      </ul>
      <div className="tag-add">
        <input type="text" value={draft} placeholder={placeholder} aria-label={`Add to ${label}`} data-testid={testid} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} />
        <button type="button" onClick={add}>Add</button>
      </div>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
export function Card({ title, children, note }) {
  return (
    <section className="card">
      {title && <h3>{title}</h3>}
      {note && <p className="card-note">{note}</p>}
      {children}
    </section>
  );
}
