import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, RefreshCw, Wallet, KeyRound, Clock3, CheckCircle2 } from 'lucide-react';
import type { KeyView, NotificationEvent, RefreshTask } from '../../../../packages/shared/types.ts';
import { formatAmount } from '../../../../packages/shared/amount.ts';
import type { AppState, History } from '../api.ts';
import { api, dateTime, relativeTime } from '../api.ts';
import { Badge, Button, Empty, Segmented } from './ui.tsx';
import type { Tone } from './ui.tsx';

export function keyState(item: KeyView): { label: string; tone: Tone; attention: boolean } {
  if (!item.enabled) return { label: '已停用', tone: 'neutral', attention: false };
  const task = item.lastTask?.state;
  if (task === 'running' || task === 'queued') return { label: '查询中', tone: 'blue', attention: false };
  if (task === 'failed') return { label: '查询失败', tone: 'red', attention: true };
  if (item.latest?.active === false) return { label: '令牌停用', tone: 'red', attention: true };
  if (item.latest?.expiresAt && item.latest.expiresAt * 1000 < Date.now()) return { label: '已过期', tone: 'red', attention: true };
  if (!item.latest) return { label: '待查询', tone: 'neutral', attention: false };
  if (item.low) return { label: '低额度', tone: 'amber', attention: true };
  if (item.stale) return { label: '数据过期', tone: 'amber', attention: true };
  return { label: '正常', tone: 'green', attention: false };
}
export function KeyStatus({ item }: { item: KeyView }) {
  const state = keyState(item);
  return <Badge tone={state.tone}>{state.label === '查询中' && <RefreshCw size={11} className="spin" />}{state.label}</Badge>;
}
export function Balance({ item, large = false }: { item: KeyView; large?: boolean }) {
  const q = item.latest;
  return <span className={large ? 'balance-large' : 'balance'}>{q?.unlimited ? '无限额度' : formatAmount(q?.remaining ?? null, q?.unit)}{q?.accuracy === 'estimated' && <span className="estimate">估算</span>}</span>;
}
export function UsageBar({ item }: { item: KeyView }) {
  const q = item.latest;
  if (!q || q.unlimited || q.total === null || q.remaining === null || Number(q.total) <= 0) return null;
  // Display-only approximation; amounts stay decimal strings everywhere else.
  const ratio = Math.min(1, Math.max(0, Number(q.remaining) / Number(q.total)));
  return <span className={`usage-bar ${item.low ? 'usage-low' : ''}`} role="img" aria-label={`剩余 ${Math.round(ratio * 100)}%`} title={`剩余 ${(ratio * 100).toFixed(1)}%`}><i style={{ width: `${ratio * 100}%` }} /></span>;
}
export function Delta({ item }: { item: KeyView }) {
  const delta = item.latest?.delta;
  if (!delta || delta === '0') return <span className="muted">—</span>;
  const down = delta.startsWith('-');
  return <span className={`delta ${down ? 'delta-down' : 'delta-up'}`}>{down ? <ArrowDownRight size={13} /> : <ArrowUpRight size={13} />}{formatAmount(down ? delta.slice(1) : delta, item.latest?.unit)}</span>;
}
export const notificationLabels: Record<NotificationEvent['state'], { label: string; tone: Tone }> = {
  sent: { label: '已发送', tone: 'green' }, unconfirmed: { label: '已提交', tone: 'green' }, pending: { label: '等待发送', tone: 'neutral' },
  failed: { label: '发送失败', tone: 'red' }, skipped: { label: '无通知目标', tone: 'neutral' },
};
export function HistoryChart({ keyId, refreshMinutes }: { keyId: string; refreshMinutes: number }) {
  const history = useQuery({ queryKey: ['history', keyId, 0], queryFn: () => api<History>(`/keys/${keyId}/history?page=0`), refetchInterval: 10000, enabled: Boolean(keyId) });
  if (!keyId) return <Empty title="还没有采样" description="添加 Key 后会自动查询并开始记录。" />;
  if (history.isPending) return <div className="chart-placeholder" role="status">正在读取…</div>;
  if (history.isError) return <div className="inline-error" role="alert">{history.error.message}<Button variant="ghost" onClick={() => void history.refetch()}>重试</Button></div>;
  const all = [...(history.data?.snapshots ?? [])].reverse();
  const unit = all.at(-1)?.unit;
  const snapshots = all.filter(q => q.unit === unit);
  const finite = snapshots.filter(q => q.remaining !== null && !q.unlimited);
  if (finite.length < 2) return <div className="chart-placeholder">{finite.length ? '再采样一次后显示变化曲线' : '暂无有限额度采样'}</div>;
  const segments = [...new Set(finite.map(s => s.segment))];
  const points: Record<string, string | number | null>[] = [];
  let previous = 0;
  for (const snapshot of snapshots) {
    const time = Date.parse(snapshot.sampledAt);
    if (previous && time - previous > refreshMinutes * 120000) points.push({ time: previous + 1 });
    points.push({ time, [`balance_${snapshot.segment}`]: snapshot.remaining === null || snapshot.unlimited ? null : Number(snapshot.remaining) });
    previous = time;
  }
  return <div className="chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={points} margin={{ top: 12, right: 12, left: 0, bottom: 4 }} accessibilityLayer>
    <CartesianGrid stroke="var(--border)" vertical={false} strokeDasharray="3 6" />
    <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={time => dateTime(new Date(time).toISOString()).slice(0, -3)} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} minTickGap={40} fontSize={11} />
    <YAxis stroke="var(--muted-foreground)" tickLine={false} axisLine={false} width={56} fontSize={11} tickFormatter={n => new Intl.NumberFormat('en', { notation: 'compact' }).format(n)} />
    <Tooltip labelFormatter={time => dateTime(new Date(Number(time)).toISOString())} formatter={value => [formatAmount(String(value), unit), '剩余']} contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--foreground)', fontSize: 12 }} />
    {segments.map(segment => <Line key={segment} dataKey={`balance_${segment}`} type="monotone" stroke="var(--primary)" strokeWidth={2} dot={finite.length < 15 ? { r: 3, fill: 'var(--primary)' } : false} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />)}
  </LineChart></ResponsiveContainer></div>;
}
export function Overview({ data, addProvider, openKey, showAttention }: { data: AppState; addProvider: () => void; openKey: (key: KeyView) => void; showAttention: () => void }) {
  const [selected, setSelected] = useState('');
  const enabled = data.keys.filter(k => k.enabled);
  const attention = enabled.filter(k => keyState(k).attention);
  const chartKey = data.keys.find(k => k.id === selected) ?? data.keys.find(k => k.latest && !k.latest.unlimited) ?? data.keys[0];
  const last = data.keys.map(k => k.latest?.sampledAt).filter((t): t is string => Boolean(t)).sort().at(-1);
  if (!data.providers.length) return <section className="panel onboarding"><h2>开始追踪你的 AI 额度</h2><p>先添加一个供应商，再把 Key 放进去。之后会自动巡检、记录变化，并通过 QQ 或 Telegram 提醒你。</p>
    <ol className="onboarding-steps"><li>添加供应商</li><li>添加或批量导入 Key</li><li>可选：连接消息平台</li></ol><Button onClick={addProvider}>添加第一个供应商</Button></section>;
  return <>
    <div className="stats-grid">
      <div className="stat-card stat-primary"><span className="stat-label"><Wallet size={16} />确认剩余额度</span>
        <div className="stat-value">{data.totals.length ? data.totals.map(t => <span key={t.unit}>{formatAmount(t.remaining, t.unit)}</span>) : '—'}</div>
        <span className="stat-note">{data.totals.length ? `${data.totals.reduce((n, t) => n + t.count, 0)} 份独立余额合计` : '在 Key 设置中选择汇总方式后显示'}</span></div>
      <button type="button" className="stat-card" onClick={showAttention} disabled={!attention.length}><span className="stat-label"><KeyRound size={16} />Key</span>
        <div className="stat-value">{enabled.length}<span className="stat-denominator">/ {data.keys.length} 启用</span></div>
        <span className={attention.length ? 'stat-note warning-text' : 'stat-note'}>{attention.length ? `${attention.length} 个需要关注 →` : '全部正常'}</span></button>
      <div className="stat-card"><span className="stat-label"><Clock3 size={16} />自动巡检</span>
        <div className="stat-value">{data.settings.refreshMinutes}<span className="stat-denominator">分钟一次</span></div>
        <span className="stat-note">最近采样 {relativeTime(last)}</span></div>
    </div>
    <div className="overview-grid">
      <section className="panel"><div className="panel-heading"><div><h2>额度变化</h2></div>
        {data.keys.length > 1 && <select aria-label="选择 Key" value={chartKey?.id ?? ''} onChange={e => setSelected(e.target.value)}>{data.keys.map(k => <option key={k.id} value={k.id}>{k.providerName} / {k.name}</option>)}</select>}</div>
        <HistoryChart keyId={chartKey?.id ?? ''} refreshMinutes={data.settings.refreshMinutes} /></section>
      <section className="panel"><div className="panel-heading"><div><h2>需要关注</h2></div>{attention.length > 0 && <Badge tone="amber">{attention.length}</Badge>}</div>
        {attention.length ? <div className="attention-list">{attention.slice(0, 6).map(k => <button key={k.id} onClick={() => openKey(k)}><span><strong>{k.name}</strong><small>{k.providerName}</small></span><span className="attention-right"><Balance item={k} /><KeyStatus item={k} /></span></button>)}</div>
          : <div className="all-good"><CheckCircle2 size={22} /><span>一切正常</span><small>低额度、查询失败和过期会显示在这里</small></div>}</section>
    </div>
    <section className="panel"><div className="panel-heading"><div><h2>最近通知</h2></div></div>
      {data.notifications.length ? <div className="notification-list">{data.notifications.slice(0, 5).map(event => <div key={event.id}><span><strong>{event.text.split('\n')[0]}</strong><small>{relativeTime(event.createdAt)}</small></span><Badge tone={notificationLabels[event.state].tone}>{notificationLabels[event.state].label}</Badge></div>)}</div>
        : <p className="panel-empty-note">还没有通知。在「消息」页设置提醒目标后，低额度提醒和日报会发到聊天里。</p>}</section>
  </>;
}
const taskLabels: Record<RefreshTask['state'], string> = { queued: '排队中', running: '查询中', success: '成功', failed: '失败', cancelled: '已取消' };
const sources: Record<string, string> = { web: '管理台', schedule: '自动巡检', qq: 'QQ', telegram: 'Telegram' };
export function TaskLog({ tasks, names }: { tasks: RefreshTask[]; names?: Record<string, string> }) {
  return tasks.length ? <div className="task-list">{tasks.map(task => <div key={task.id}><Badge tone={task.state === 'success' ? 'green' : task.state === 'failed' ? 'red' : 'neutral'}>{taskLabels[task.state]}</Badge><span><strong>{names?.[task.keyId] ?? sources[task.source] ?? task.source}</strong>{(task.error || names) && <small>{task.error ?? sources[task.source] ?? task.source}</small>}</span><time title={dateTime(task.createdAt)}>{relativeTime(task.createdAt)}</time></div>)}</div> : <p className="panel-empty-note">尚无查询记录</p>;
}
export function KeyDetail({ item, refreshMinutes, refresh }: { item: KeyView; refreshMinutes: number; refresh: () => void }) {
  const [page, setPage] = useState(0), [tab, setTab] = useState<'snapshots' | 'tasks'>('snapshots');
  const history = useQuery({ queryKey: ['history', item.id, page], queryFn: () => api<History>(`/keys/${item.id}/history?page=${page}`), refetchInterval: 10000 });
  const q = item.latest;
  const scope = q?.scope === 'token' ? 'Key 配额' : q?.scope === 'account' ? '账户余额' : '口径未确认';
  return <div className="key-detail">
    <div className="detail-summary"><div><p>{item.providerName} · <code>{item.mask}</code></p><Balance item={item} large />
      <div className="detail-badges"><KeyStatus item={item} /><Badge>{scope}</Badge>{q && <Badge>{relativeTime(q.sampledAt)}更新</Badge>}</div></div>
      <Button variant="outline" onClick={refresh} disabled={!item.enabled}><RefreshCw size={15} />刷新</Button></div>
    <UsageBar item={item} />
    {item.lastTask?.state === 'failed' && <div className="inline-error" role="alert">{item.lastTask.error}。下方保留最后一次成功的数据。</div>}
    <div className="detail-metrics"><div><small>总额度</small><strong>{q?.unlimited ? '无限' : formatAmount(q?.total ?? null, q?.unit)}</strong></div><div><small>已用</small><strong>{formatAmount(q?.used ?? null, q?.unit)}</strong></div><div><small>最近变化</small><Delta item={item} /></div><div><small>有效期</small><strong>{q?.expiresAt ? dateTime(new Date(q.expiresAt * 1000).toISOString()) : '长期'}</strong></div></div>
    {q?.period && <p className="form-note">用量窗口 {q.period.start} 至 {q.period.end}（UTC），余额为估算值。</p>}
    <HistoryChart keyId={item.id} refreshMinutes={refreshMinutes} />
    <div className="detail-tabs"><Segmented label="记录类型" value={tab} onChange={setTab} options={[{ id: 'snapshots', label: '采样记录' }, { id: 'tasks', label: '查询记录' }]} />
      <div className="pagination"><Button variant="ghost" aria-label="上一页" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></Button><span className="muted">第 {page + 1} 页</span><Button variant="ghost" aria-label="下一页" disabled={(history.data?.snapshots.length ?? 0) < 200 && (history.data?.tasks.length ?? 0) < 50} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></Button></div></div>
    {history.isError && <div className="inline-error" role="alert">{history.error.message}</div>}
    {tab === 'snapshots' ? history.data?.snapshots.length ? <div className="history-table"><table><thead><tr><th>时间</th><th>剩余</th><th>已用</th><th>状态</th></tr></thead><tbody>{history.data.snapshots.map(s => <tr key={s.id}><td>{dateTime(s.sampledAt)}</td><td>{s.unlimited ? '无限' : formatAmount(s.remaining, s.unit)}</td><td>{formatAmount(s.used, s.unit)}</td><td>{s.accuracy === 'estimated' ? '估算' : s.status}</td></tr>)}</tbody></table></div> : <p className="panel-empty-note">本页没有采样记录。</p>
      : <div className="history-box"><TaskLog tasks={history.data?.tasks ?? []} /></div>}
    <p className="form-note mono">Key ID：{item.id}（可用于 Bot 命令精确指定）</p>
  </div>;
}
