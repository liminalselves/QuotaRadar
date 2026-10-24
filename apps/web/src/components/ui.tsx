import type { ButtonHTMLAttributes, ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X, LoaderCircle, Plus, Radar } from 'lucide-react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: Parameters<typeof clsx>) { return twMerge(clsx(...inputs)); }
export function Button({ className, variant = 'default', loading, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost' | 'danger'; loading?: boolean }) {
  return <button {...props} className={cn('button', `button-${variant}`, className)} disabled={props.disabled || loading}>{loading && <LoaderCircle size={16} className="spin" aria-hidden="true" />}{children}</button>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' }) {
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
  return <div className="empty"><div className="empty-symbol"><Radar size={30} strokeWidth={1.3} aria-hidden="true" /></div><h3>{title}</h3><p>{description}</p>{action && <Button onClick={onAction}><Plus size={16} />{action}</Button>}</div>;
}
export function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string }) {
  return <label className="check-field"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /><span>{label}{hint && <small>{hint}</small>}</span></label>;
}
