const BASE = 'http://localhost:3000';

async function test() {
  console.log('========== 开始 API 测试 ==========\n');

  const userId = 'user_001';

  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  };

  const reports = [
    { userId, productId: 'sanitary_pad_regular', quantity: 30, cyclePhase: 'menstrual', timestamp: daysAgo(30) },
    { userId, productId: 'sanitary_pad_night', quantity: 16, cyclePhase: 'menstrual', timestamp: daysAgo(30) },
    { userId, productId: 'panty_liner', quantity: 60, cyclePhase: 'menstrual', timestamp: daysAgo(30) },

    { userId, productId: 'sanitary_pad_regular', quantity: 18, cyclePhase: 'follicular', timestamp: daysAgo(20) },
    { userId, productId: 'sanitary_pad_night', quantity: 10, cyclePhase: 'follicular', timestamp: daysAgo(20) },
    { userId, productId: 'panty_liner', quantity: 45, cyclePhase: 'follicular', timestamp: daysAgo(20) },

    { userId, productId: 'sanitary_pad_regular', quantity: 8, cyclePhase: 'luteal', timestamp: daysAgo(10) },
    { userId, productId: 'sanitary_pad_night', quantity: 4, cyclePhase: 'luteal', timestamp: daysAgo(10) },
    { userId, productId: 'panty_liner', quantity: 30, cyclePhase: 'luteal', timestamp: daysAgo(10) },

    { userId, productId: 'sanitary_pad_regular', quantity: 3, cyclePhase: 'menstrual', timestamp: daysAgo(2) },
    { userId, productId: 'sanitary_pad_night', quantity: 1, cyclePhase: 'menstrual', timestamp: daysAgo(2) },
    { userId, productId: 'panty_liner', quantity: 20, cyclePhase: 'menstrual', timestamp: daysAgo(2) },

    { userId, productId: 'pain_relief', quantity: 10, cyclePhase: 'menstrual', timestamp: daysAgo(30) },
    { userId, productId: 'pain_relief', quantity: 6, cyclePhase: 'menstrual', timestamp: daysAgo(2) }
  ];

  console.log('1. 上报库存数据...');
  for (const r of reports) {
    const res = await fetch(`${BASE}/api/inventory/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(r)
    });
    const data = await res.json();
    console.log(`   - ${data.code === 0 ? '✓' : '✗'} ${r.productId}: ${data.message}` + (data.data?.anomalyDetected ? ' [检测到异常]' : ''));
  }

  console.log('\n2. 测试消耗预测接口...');
  let res = await fetch(`${BASE}/api/forecast/${userId}`);
  let data = await res.json();
  console.log(`   ${data.code === 0 ? '✓' : '✗'} ${data.message}`);
  if (data.data?.summary) {
    console.log(`     - 跟踪产品数: ${data.data.summary.trackedProducts}`);
    console.log(`     - 预警产品数: ${data.data.summary.warningProducts + data.data.summary.criticalProducts}`);
    console.log(`     - 预估周期花费: ¥${data.data.summary.estimatedCycleCost}`);
  }

  console.log('\n3. 测试补货建议接口...');
  res = await fetch(`${BASE}/api/recommendation/${userId}?cycles=1`);
  data = await res.json();
  console.log(`   ${data.code === 0 ? '✓' : '✗'} ${data.message}`);
  if (data.data?.urgencySummary) {
    console.log(`     - 立即购买: ${data.data.urgencySummary.immediate}`);
    console.log(`     - 近期购买: ${data.data.urgencySummary.warning}`);
    console.log(`     - 预估总花费: ¥${data.data.totalEstimatedCost}`);
    console.log(`     - 平均消耗周期: ${data.data.averageConsumptionCycles?.length || 0} 种产品`);
  }

  console.log('\n4. 测试偏好学习接口...');
  res = await fetch(`${BASE}/api/preference/${userId}`);
  data = await res.json();
  console.log(`   ${data.code === 0 ? '✓' : '✗'} ${data.message}`);
  if (data.data?.learnedInsights) {
    console.log(`     - 学习状态: ${data.data.learnedInsights.learningStatus}`);
    console.log(`     - 数据点数: ${data.data.learnedInsights.dataPoints}`);
    console.log(`     - 异常总数: ${data.data.anomalies.totalCount}`);
    console.log(`     - 产品偏好数: ${data.data.productPreferences?.length || 0}`);
  }

  console.log('\n5. 测试更新偏好接口...');
  res = await fetch(`${BASE}/api/preference/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cycleLength: 30, menstrualLength: 6, budgetLevel: 'economy'
    })
  });
  data = await res.json();
  console.log(`   ${data.code === 0 ? '✓' : '✗'} ${data.message}`);

  console.log('\n6. 测试历史记录接口...');
  res = await fetch(`${BASE}/api/inventory/history/${userId}`);
  data = await res.json();
  console.log(`   ${data.code === 0 ? '✓' : '✗'} ${data.message} - 共 ${data.data?.totalReports || 0} 条记录`);

  console.log('\n========== 测试完成 ==========');
}

test().catch(console.error);
