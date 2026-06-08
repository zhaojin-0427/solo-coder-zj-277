const BASE = 'http://localhost:3000';

async function test() {
  console.log('========== 验证本轮 4 个 Bug 修复 ==========\n');

  console.log('【修复 1】参数校验失败 HTTP 状态码应该是 400');
  const tests = [
    { url: `${BASE}/api/recommendation/x?cycles=abc`, method: 'GET', desc: 'recommendation cycles=abc' },
    { url: `${BASE}/api/recommendation/x?cycles=99`, method: 'GET', desc: 'recommendation cycles=99' },
    { url: `${BASE}/api/recommendation/x?cycles=0`, method: 'GET', desc: 'recommendation cycles=0' },
    { url: `${BASE}/api/preference/x`, method: 'PUT', body: { cycleLength: 10 }, desc: 'preference cycleLength 非法' }
  ];
  for (const t of tests) {
    const opts = { method: t.method };
    if (t.body) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(t.body);
    }
    const res = await fetch(t.url, opts);
    const data = await res.json();
    const passed = res.status === 400 && data.code === 400;
    console.log(`  ${passed ? '✓' : '✗'} ${t.desc} => HTTP ${res.status}, code ${data.code}`);
  }

  console.log('\n【修复 2】单条上报时 daysSinceLastReport 不为 0，不误判库存良好');
  const userId = 'single_report_' + Date.now();
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  };
  await fetch(`${BASE}/api/inventory/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      productId: 'sanitary_pad_regular',
      quantity: 20,
      cyclePhase: 'menstrual',
      timestamp: daysAgo(10)
    })
  });

  let res = await fetch(`${BASE}/api/recommendation/${userId}?cycles=1`);
  let data = await res.json();
  const item = data.data?.purchaseList?.[0];
  if (item) {
    console.log(`  上报时间 10 天前`);
    console.log(`  daysSinceLastReport: ${item.daysSinceLastReport}`);
    console.log(`  stockIsStale: ${item.stockIsStale}`);
    console.log(`  tips: ${data.data?.tips?.join(' | ')}`);
    const notZero = item.daysSinceLastReport >= 9;
    const hasInsufficientTip = data.data?.tips?.some(t => t.includes('数据不足'));
    console.log(`  ${notZero ? '✓' : '✗'} daysSinceLastReport 正确 (>=9)`);
    console.log(`  ${hasInsufficientTip ? '✓' : '✗'} tips 提示数据不足，而非库存良好`);
  }

  res = await fetch(`${BASE}/api/forecast/${userId}`);
  data = await res.json();
  const fItem = data.data?.productForecasts?.[0];
  if (fItem) {
    console.log(`  forecast daysSinceLastReport: ${fItem.daysSinceLastReport}`);
    console.log(`  forecast stockIsStale: ${fItem.stockIsStale}`);
    console.log(`  forecast stockNote: ${fItem.stockNote}`);
    const ok = fItem.daysSinceLastReport >= 9 && fItem.stockIsStale === true;
    console.log(`  ${ok ? '✓' : '✗'} forecast 数据正确`);
  }

  console.log('\n【修复 3】未来时间戳被拒绝');
  const futureTs = new Date();
  futureTs.setDate(futureTs.getDate() + 3);
  res = await fetch(`${BASE}/api/inventory/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'future_test',
      productId: 'sanitary_pad_regular',
      quantity: 20,
      timestamp: futureTs.toISOString()
    })
  });
  data = await res.json();
  const rejectedFuture = res.status === 400 && data.code === 400;
  console.log(`  HTTP ${res.status}, code ${data.code}, msg: ${data.message}`);
  console.log(`  ${rejectedFuture ? '✓' : '✗'} 未来时间戳被拒绝`);

  console.log('\n【修复 4】非法时间戳被拒绝');
  res = await fetch(`${BASE}/api/inventory/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: 'bad_ts_test',
      productId: 'sanitary_pad_regular',
      quantity: 20,
      timestamp: 'not-a-date'
    })
  });
  data = await res.json();
  const rejectedBad = res.status === 400 && data.code === 400;
  console.log(`  HTTP ${res.status}, code ${data.code}, msg: ${data.message}`);
  console.log(`  ${rejectedBad ? '✓' : '✗'} 非法时间戳被拒绝`);

  console.log('\n========== 全部验证完成 ==========');
}

test().catch(console.error);
