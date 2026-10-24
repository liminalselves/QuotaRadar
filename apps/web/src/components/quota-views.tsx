import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { ArrowDownRight, ArrowUpRight, CircleAlert, Clock3, Wallet, KeyRound, RefreshCw, Activity, ChevronLeft, ChevronRight } from 'lucide-react';
import type { KeyView, RefreshTask } from '../../../../packages/shared/types.ts';
import { formatAmount } from '../../../../packages/shared/amount.ts';
import type { AppState, History } from '../api.ts';
import { api, dateTime } from '../api.ts';
import { Badge, Button, Empty } from './ui.tsx';
export function KeyStatus({ item }: { item: KeyView }) {
  if (!item.enabled) return <Badge>已停用</Badge>;
  if (item.lastTask?.state === 'running' || item.lastTask?.state === 'queued') return <Badge tone="blue"><RefreshCw size={11} className="spin" />查询中</Badge>;
  if (item.lastTask?.state === 'failed') return <Badge tone="red">查询失败</Badge>;
  if (item.latest?.active === false) return <Badge tone="red">令牌停用</Badge>;
  if (item.latest?.expiresAt && item.latest.expiresAt * 1000 < Date.now()) return <Badge tone="red">已过期</Badge>;
  if (!item.latest) return <Badge>待查询</Badge>;
  if (item.stale) return <Badge tone="amber">数据过期</Badge>;
  if (item.low) return <Badge tone="amber">低额度</Badge>;
  return <Badge tone="green">正常</Badge>;
}
export function Balance({ item, large = false }: { item: KeyView; large?: boolean }) {
  const q = item.latest;
  return <span className={large ? 'balance-large' : 'balance'}>{q?.unlimited ? '无限额度' : formatAmount(q?.remaining ?? null, q?.unit)}{q?.accuracy === 'estimated' && <span className="estimate">估算</span>}</span>;
}
export function Delta({ item }: { item: KeyView }) {
  const delta = item.latest?.delta;
  if (!delta) return <span className="muted">—</span>;
  const down = delta.startsWith('-');
  return <span className={`delta ${down ? 'delta-down' : 'delta-up'}`}>{down ? <ArrowDownRight size={14} /> : <ArrowUpRight size={14} />}{formatAmount(delta, item.latest?.unit)}</span>;
}
export function HistoryChart({ keyId, refreshMinutes }: { keyId: string; refreshMinutes: number }) {
  const history = useQuery({ queryKey: ['history', keyId, 0], queryFn: () => api<History>(`/keys/${keyId}/history?page=0`), refetchInterval: 5000, enabled: Boolean(keyId) });
  if (!keyId) return <Empty title="额度变化会出现在这里" description="添加 Key 并完成首次查询后，开始记录真实采样。" />;
  if (history.isPending) return <div className="chart-placeholder" role="status">正在读取采样记录…</div>;
  if (history.isError) return <div className="inline-error" role="alert">{history.error.message}<Button variant="ghost" onClick={() => void history.refetch()}>重试</Button></div>;
  const allSnapshots = [...(history.data?.snapshots ?? [])].reverse();
  const unit = allSnapshots.at(-1)?.unit;
  const snapshots = allSnapshots.filter(q => q.unit === unit);
  const finite = snapshots.filter(q => q.remaining !== null && !q.unlimited);
  if (!finite.length) return <Empty title="还没有有限额度采样" description="无限额度和查询失败不会生成虚假的余额点。" />;
  const segments = [...new Set(finite.map(s => s.segment))];
  const points: Record<string, string | number | null>[] = [];
  let previous = 0;
  for (const snapshot of snapshots) {
    const time = Date.parse(snapshot.sampledAt);
    if (previous && time - previous > refreshMinutes * 120000) points.push({ time: previous + 1 });
    points.push({ time, [`balance_${snapshot.segment}`]: snapshot.remaining === null || snapshot.unlimited ? null : Number(snapshot.remaining) });
    previous = time;
  }
  return <><div className="chart-meta"><span><i className="legend-line" />剩余额度 · {finite.at(-1)!.unit}</span><span>最近 {snapshots.length} 次采样 · 时间为浏览器本地时区</span></div>
    <div className="chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={points} margin={{ top: 20, right: 15, left: 0, bottom: 12 }} accessibilityLayer>
      <CartesianGrid stroke="var(--border)" vertical={false} strokeDasharray="3 6" />
      <XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={time => dateTime(new Date(time).toISOString()).slice(0, -3)} stroke="var(--muted-foreground)" tickLine={false} axisLine={false} minTickGap={35} fontSize={11} />
      <YAxis stroke="var(--muted-foreground)" tickLine={false} axisLine={false} width={65} fontSize={11} tickFormatter={n => new Intl.NumberFormat('en', { notation: 'compact' }).format(n)} />
      <Tooltip labelFormatter={time => dateTime(new Date(Number(time)).toISOString())} formatter={value => [formatAmount(String(value), finite.at(-1)!.unit), '剩余']} contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--foreground)' }} />
      {segments.map(segment => <Line key={segment} dataKey={`balance_${segment}`} type="linear" stroke="var(--primary)" strokeWidth={2} dot={finite.length < 15 ? { r: 3, fill: 'var(--primary)' } : false} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />)}
    </LineChart></ResponsiveContainer></div><p className="chart-footnote">线段断开表示数据缺口或口径变更。余额增加不等于负消费。</p></>;
}
export function Overview({ data, addProvider, openKey }: { data: AppState; addProvider: () => void; openKey: (key: KeyView) => void }) {
  const [selected, setSelected] = useState('');
  const chartKey = data.keys.find(k => k.id === selected) ?? data.keys.find(k => k.latest) ?? data.keys[0];
  const low = data.keys.filter(k => k.enabled && k.low);
  const failed = data.keys.filter(k => k.enabled && (k.lastTask?.state === 'failed' || k.latest?.active === false));
  const stale = data.keys.filter(k => k.enabled && k.stale);
  const needsAttention = data.keys.filter(k => low.includes(k) || failed.includes(k) || stale.includes(k)).slice(0, 6);
  return <><div className="stats-grid"><div className="stat-card balance-card"><span className="stat-label"><Wallet size={17} />确认剩余额度</span>
    <div className="stat-value">{data.totals.length ? data.totals.map(t => <span key={t.unit}>{formatAmount(t.remaining, t.unit)}</span>) : '—'}</div>
    <span className="stat-note">{data.totals.length ? `已去重，共 ${data.totals.reduce((n, t) => n + t.count, 0)} 份有效余额` : '确认额度范围和汇总方式后显示'}</span></div>
    <div className="stat-card"><span className="stat-label"><KeyRound size={17} />启用的 Key</span><div className="stat-value">{data.keys.filter(k => k.enabled).length}<span className="stat-denominator">/ {data.keys.length}</span></div><span className="stat-note">来自 {data.providers.length} 个供应商</span></div>
    <div className="stat-card"><span className="stat-label"><CircleAlert size={17} />需要留意</span><div className="stat-value warning-text">{new Set([...low, ...failed]).size}</div><span className="stat-note">{low.length} 个低额度 · {failed.length} 个异常</span></div>
    <div className="stat-card"><span className="stat-label"><Clock3 size={17} />自动巡检</span><div className="stat-value">{data.settings.refreshMinutes}<span className="stat-denominator">分钟</span></div><span className="stat-note">{stale.length ? `${stale.length} 个 Key 待更新` : '数据已更新'}</span></div>
  </div>
  {!data.providers.length ? <div className="panel onboarding"><div className="eyebrow">START WITH A PROVIDER</div><h2>把散落的 Key，放在一起。</h2><p>同一种查询方式只配置一次。之后添加 Key，刷新、留存历史，或者让 Bot 帮你看。</p><div className="onboarding-steps"><span><b>01</b>选择查询类型</span><span><b>02</b>添加你的 Key</span><span><b>03</b>查看额度变化</span></div><Button onClick={addProvider}>添加第一个供应商</Button></div>
    : <div className="overview-grid"><section className="panel"><div className="panel-heading"><div><h2>额度变化</h2><p>看清余额，而不只是一个数字</p></div><select aria-label="选择图表 Key" value={chartKey?.id ?? ''} onChange={e => setSelected(e.target.value)}>{data.keys.map(k => <option key={k.id} value={k.id}>{k.providerName} / {k.name}</option>)}</select></div><HistoryChart keyId={chartKey?.id ?? ''} refreshMinutes={data.settings.refreshMinutes} /></section>
      <section className="panel"><div className="panel-heading"><div><h2>待关注</h2><p>低额度、失败和待更新的 Key</p></div><Badge>{needsAttention.length}</Badge></div>{needsAttention.length ? <div className="attention-list">{needsAttention.map(k => <button key={k.id} onClick={() => openKey(k)}><span className="provider-initial">{k.providerName.slice(0, 1)}</span><span><strong>{k.name}</strong><small>{k.providerName}</small></span><span className="attention-right"><Balance item={k} /><KeyStatus item={k} /></span></button>)}</div> : <Empty title="暂时没有需要处理的项目" description="巡检异常和低额度提醒会在这里汇总。" />}</section></div>}
  <section className="panel"><div className="panel-heading"><div><h2>最近通知</h2><p>提醒、日报与发送结果</p></div><Activity size={18} className="muted" /></div>{data.notifications.length ? <div className="notification-list">{data.notifications.slice(0, 6).map(event => <div key={event.id}><span className="notification-dot" /><span><strong>{event.text.split('\n')[0]}</strong><small>{dateTime(event.createdAt)}</small></span><Badge tone={event.state === 'sent' ? 'green' : event.state === 'failed' ? 'red' : 'neutral'}>{{ sent: '已发送', pending: '等待发送', failed: '发送失败', skipped: '未配置通知目标' }[event.state]}</Badge></div>)}</div> : <p className="panel-empty-note">还没有通知。你可以在「消息平台」设置接收目标。</p>}</section>
  <p className="page-footnote">合计不包含无限、估算、过期、失败或未确认独立性的额度。不同单位分别显示。</p></>;
}
const taskLabels: Record<RefreshTask['state'], string> = { queued: '排队中', running: '查询中', success: '成功', failed: '失败', cancelled: '已取消' };
export function TaskLog({ tasks, names }: { tasks: RefreshTask[]; names?: Record<string, string> }) {
  return tasks.length ? <div className="task-list">{tasks.map(task => <div key={task.id}><Badge tone={task.state === 'success' ? 'green' : task.state === 'failed' ? 'red' : 'neutral'}>{taskLabels[task.state]}</Badge><span><strong>{names?.[task.keyId] ?? task.source}</strong><small>{task.error ?? ({ web: '管理台刷新', schedule: '自动巡检', qq: 'QQ 刷新', telegram: 'Telegram 刷新' } as Record<string, string>)[task.source] ?? task.source}</small></span><time>{dateTime(task.createdAt)}</time></div>)}</div> : <p className="panel-empty-note">尚无查询记录</p>;
}
export function KeyDetail({ item, refreshMinutes, refresh }: { item: KeyView; refreshMinutes: number; refresh: () => void }) {
  const [page, setPage] = useState(0);
  const history = useQuery({ queryKey: ['history', item.id, page], queryFn: () => api<History>(`/keys/${item.id}/history?page=${page}`), refetchInterval: 5000 });
  const q = item.latest;
  return <div className="key-detail"><div className="detail-summary"><div><p>{item.providerName} / {item.mask}</p><Balance item={item} large /><div className="detail-badges"><KeyStatus item={item} /><Badge>{q?.scope === 'token' ? 'Key 配额' : q?.scope === 'account' ? '账户余额' : '口径待确认'}</Badge>{q?.accuracy === 'estimated' && <Badge tone="amber">估算余额</Badge>}</div></div><Button variant="outline" onClick={refresh} disabled={!item.enabled}><RefreshCw size={15} />刷新额度</Button></div>
    <div className="detail-metrics"><div><small>总额度</small><strong>{q?.unlimited ? '无限' : formatAmount(q?.total ?? null, q?.unit)}</strong></div><div><small>已用</small><strong>{formatAmount(q?.used ?? null, q?.unit)}</strong></div><div><small>最近变化</small><Delta item={item} /></div><div><small>有效期</small><strong>{q?.expiresAt ? dateTime(new Date(q.expiresAt * 1000).toISOString()) : '未提供 / 无固定到期日'}</strong></div></div>
    {item.lastTask?.state === 'failed' && <div className="inline-error" role="alert">{item.lastTask.error}。以下保留最后一次成功数据。</div>}
    {q?.period && <p className="form-note">用量窗口：{q.period.start} 至 {q.period.end}（UTC）。不保证等于全生命周期用量。</p>}
    <HistoryChart keyId={item.id} refreshMinutes={refreshMinutes} />
    <h3>采样记录 <span className="muted">· 第 {page + 1} 页</span></h3>
    {history.isError && <div className="inline-error" role="alert">{history.error.message}</div>}
    <div className="history-table"><table><thead><tr><th>采样时间</th><th>剩余额度</th><th>已用</th><th>状态</th></tr></thead><tbody>{history.data?.snapshots.map(s => <tr key={s.id}><td>{dateTime(s.sampledAt)}</td><td>{s.unlimited ? '无限' : formatAmount(s.remaining, s.unit)}</td><td>{formatAmount(s.used, s.unit)}</td><td>{s.accuracy === 'estimated' ? '估算' : s.status}</td></tr>)}</tbody></table></div>
    {!history.data?.snapshots.length && <p className="muted">本页没有采样记录。</p>}
    <div className="pagination"><Button variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft size={16} />上一页</Button><Button variant="ghost" disabled={(history.data?.snapshots.length ?? 0) < 200 && (history.data?.tasks.length ?? 0) < 50} onClick={() => setPage(page + 1)}>下一页<ChevronRight size={16} /></Button></div>
    <h3>查询记录</h3><TaskLog tasks={history.data?.tasks ?? []} /><p className="form-note mono">Key ID：{item.id}</p>
  </div>;
}
