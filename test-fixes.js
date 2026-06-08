const BASE = 'http://localhost:3000';

async function test() {
  console.log('========== 验证三个 Bug 修复 ==========\n');

  console.log('【修复 1】非法 JSON 返回 500');
  console.log('  发送非法 JSON...');
  let res = await fetch(`${BASE}/api/inventory/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{invalid json!!!'
  });
  let data = await res.json();
  console.log(`  HTTP 状态: ${res.status}`);
  console.log(`  code: ${data.code}, message: ${data.message}`);
  console.log(`  ${res.status === 400 && data.code === 400 ? '✓ 已修复：返回统一格式的 400 错误' : '✗ 未修复'}\n`);

  console.log('【修复 2】cycles 参数校验');
  const testCases = [
    { cycles: 'abc', expectError: true, desc: 'cycles=abc 非数字' },
    { cycles: '0', expectError: true, desc: 'cycles=0 小于1' },
    { cycles: '4', expectError: true, desc: 'cycles=4 大于3' },
    { cycles: '99', expectError: true, desc: 'cycles=99 严重超限' },
    { cycles: '1', expectError: false, desc: 'cycles=1 合法' },
    { cycles: '2', expectError: false, desc: 'cycles=2 合法' },
    { cycles: '3', expectError: false, desc: 'cycles=3 合法' }
  ];
  for (const tc of testCases) {
    res = await fetch(`${BASE}/api/recommendation/testuser?cycles=${tc.cycles}`);
    data = await res.json();
    const passed = tc.expectError ? (data.code === 400) : (data.code === 0);
    console.log(`  ${passed ? '✓' : '✗'} ${tc.desc} => code=${data.code}`);
  }

  console.log('\n【修复 3】历史库存推算当前库存');
  const userId = 'fix_test_user_' + Date.now();
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  };

  const reports = [
    { userId, productId: 'sanitary_pad_regular', quantity: 30, cyclePhase: 'menstrual', timestamp: daysAgo(30) },
    { userId, productId: 'sanitary_pad_regular', quantity: 20, cyclePhase: 'follicular', timestamp: daysAgo(20) },
    { userId, productId: 'sanitary_pad_regular', quantity: 10, cyclePhase: 'luteal', timestamp: daysAgo(10) }
  ];
  console.log('  上报3条数据，最近一次是10天前上报的10片（日均约1片）');
  for (const r of reports) {
    await fetch(`${BASE}/api/inventory/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(r)
    });
  }

  res = await fetch(`${BASE}/api/forecast/${userId}`);
  data = await res.json();
  const forecast = data.data?.productForecasts?.[0];
  if (forecast) {
    console.log(`  上报库存: ${forecast.reportedStock} 片`);
    console.log(`  推算当前库存: ${forecast.currentStock} 片`);
    console.log(`  距上次上报天数: ${forecast.daysSinceLastReport} 天`);
    console.log(`  库存剩余天数: ${forecast.stockWarning.daysLeft}`);
    const isFixed = forecast.currentStock < forecast.reportedStock && forecast.stockWarning.daysLeft !== '充足' && forecast.stockWarning.daysLeft < 5;
    console.log(`  ${isFixed ? '✓ 已修复：考虑了过去10天的消耗，当前库存和剩余天数更准确' : '✗ 可能未修复'}`);
  }

  res = await fetch(`${BASE}/api/recommendation/${userId}?cycles=1`);
  data = await res.json();
  const rec = data.data?.purchaseList?.[0];
  if (rec) {
    console.log(`\n  补货建议推算当前库存: ${rec.currentStock} 片`);
    console.log(`  距上次上报天数: ${rec.daysSinceLastReport} 天`);
    console.log(`  紧急程度: ${rec.urgency}`);
    const isFixed = rec.urgency !== '正常采购';
    console.log(`  ${isFixed ? '✓ 已修复：补货建议紧急程度更合理' : '✗ 可能未修复'}`);
  }

  console.log('\n========== 验证完成 ==========');
}

test().catch(console.error);
