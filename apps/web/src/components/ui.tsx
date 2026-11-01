import { useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X, LoaderCircle, Plus, Radar, Eye, EyeOff } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: Parameters<typeof clsx>) { return twMerge(clsx(...inputs)); }
export function Button({ className, variant = 'default', loading, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost' | 'danger'; loading?: boolean }) {
  return <button {...props} className={cn('button', `button-${variant}`, className)} disabled={props.disabled || loading}>{loading && <LoaderCircle size={16} className="spin" aria-hidden="true" />}{children}</button>;
}
export type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue';
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function Modal({ title, description, children, onClose, wide = false, returnFocusRef }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean; returnFocusRef?: { current: HTMLElement | null } }) {
  return <DialogPrimitive.Root open onOpenChange={open => { if (!open) onClose(); }}><DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="dialog-overlay" />
    <DialogPrimitive.Content className={cn('dialog-content', wide && 'dialog-wide')} aria-describedby={description ? 'dialog-description' : undefined} onCloseAutoFocus={event => { if (returnFocusRef?.current) { event.preventDefault(); returnFocusRef.current.focus(); } }}>
      <div className="dialog-heading"><div><DialogPrimitive.Title>{title}</DialogPrimitive.Title>{description && <DialogPrimitive.Description id="dialog-description">{description}</DialogPrimitive.Description>}</div>
        <DialogPrimitive.Close asChild><button className="icon-button" aria-label="关闭对话框"><X size={20} /></button></DialogPrimitive.Close></div>{children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal></DialogPrimitive.Root>;
}
export function Field({ label, children, hint, wide = false }: { label: string; children: ReactNode; hint?: string; wide?: boolean }) {
  return <label className={cn('field', wide && 'field-wide')}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Empty({ title, description, action, onAction }: { title: string; description: string; action?: string; onAction?: () => void }) {
  return <div className="empty"><div className="empty-symbol"><Radar size={28} strokeWidth={1.4} aria-hidden="true" /></div><h3>{title}</h3><p>{description}</p>{action && <Button onClick={onAction}><Plus size={16} />{action}</Button>}</div>;
}
export function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }) {
  return <label className="check-field"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /><span>{label}{hint && <small>{hint}</small>}</span></label>;
}
export function Switch({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }) {
  return <label className="switch-field"><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
    <input type="checkbox" role="switch" className="switch" checked={checked} onChange={e => onChange(e.target.checked)} /></label>;
}
export function SecretInput({ value, onChange, placeholder, required, label }: { value: string; onChange: (value: string) => void; placeholder?: string; required?: boolean; label: string }) {
  const [visible, setVisible] = useState(false);
  return <span className="secret-input"><input type={visible ? 'text' : 'password'} required={required} autoComplete="off" spellCheck={false} aria-label={label} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
    <button type="button" className="icon-button" aria-label={visible ? `隐藏${label}` : `显示${label}`} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></span>;
}
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: ReactNode }[]; onChange: (value: T) => void; label: string }) {
  return <div className="segmented" role="tablist" aria-label={label}>{options.map(o => <button key={o.id} type="button" role="tab" aria-selected={value === o.id} className={value === o.id ? 'active' : undefined} onClick={() => onChange(o.id)}>{o.label}</button>)}</div>;
}
export function Section({ title, description, actions, children, className }: { title: ReactNode; description?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={cn('panel', className)}><div className="panel-heading"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{actions && <div className="panel-actions">{actions}</div>}</div>{children}</section>;
}
