const BASE = 'http://localhost:3000';

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  const data = await res.json();
  return { status: res.status, ...data };
}

function check(name, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ' - ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

async function test() {
  console.log('========== 新功能综合测试 ==========\n');
  const uid = 'test_sub_' + Date.now();
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };

  console.log('【1】上报基础数据建立消耗基线');
  for (let i = 0; i < 4; i++) {
    await api('POST', '/api/inventory/report', {
      userId: uid, productId: 'sanitary_pad_regular',
      quantity: 30 - i * 5, cyclePhase: i === 0 ? 'menstrual' : 'luteal',
      timestamp: daysAgo(30 - i * 7)
    });
  }
  for (let i = 0; i < 4; i++) {
    await api('POST', '/api/inventory/report', {
      userId: uid, productId: 'sanitary_pad_night',
      quantity: 20 - i * 3, cyclePhase: i === 0 ? 'menstrual' : 'follicular',
      timestamp: daysAgo(30 - i * 7)
    });
  }
  console.log('  已上报 8 条记录\n');

  console.log('【2】配置订阅补货策略');
  let r = await api('PUT', `/api/subscription/${uid}/config`, {
    enabled: true, cyclesAhead: 2,
    globalMaxBudget: 200, globalMinSafetyStockDays: 5,
    productStrategies: {
      sanitary_pad_regular: {
        cyclesAhead: 2, maxBudget: 100, minSafetyStockDays: 7, autoConfirm: false,
        skipRules: { skipEveryNthCycle: 0, skipOnCertainPhases: [] }
      },
      sanitary_pad_night: {
        minSafetyStockDays: 5,
        skipRules: { skipOnCertainPhases: ['ovulation'] }
      }
    }
  });
  check('HTTP 200 & code 0', r.status === 200 && r.code === 0, `HTTP=${r.status} code=${r.code}`);
  check('subscription.enabled=true', r.data?.subscription?.enabled === true);
  check('cyclesAhead=2', r.data?.subscription?.cyclesAhead === 2);
  check('globalMaxBudget=200', r.data?.subscription?.globalMaxBudget === 200);
  check('产品策略包含 sanitary_pad_regular', !!r.data?.subscription?.productStrategies?.sanitary_pad_regular);
  console.log('');

  console.log('【3】获取订阅配置');
  r = await api('GET', `/api/subscription/${uid}/config`);
  check('查询返回 enabled=true', r.data?.subscription?.enabled === true);
  check('返回可用产品列表', Array.isArray(r.data?.availableProducts) && r.data.availableProducts.length > 0);
  console.log('');

  console.log('【4】预览补货计划');
  r = await api('GET', `/api/subscription/${uid}/plan/preview`);
  check('HTTP 200 & code 0', r.status === 200 && r.code === 0);
  check('返回 plan 对象', !!r.data?.plan);
  check('plan 包含 planId', !!r.data.plan.planId);
  check('plan 状态为 draft', r.data.plan.status === 'draft');
  check('plan 包含 2 个周期', r.data.plan.cycles?.length === 2, `实际=${r.data.plan.cycles?.length}`);
  check('factorsConsidered 包含所有因素',
    r.data.plan.factorsConsidered?.historicalConsumption === true &&
    r.data.plan.factorsConsidered?.cyclePhase === true &&
    r.data.plan.factorsConsidered?.anomalyDetection === true &&
    r.data.plan.factorsConsidered?.budgetPreferences === true &&
    r.data.plan.factorsConsidered?.promoSavings === true);
  check('summary 包含 grandTotalCost', typeof r.data.plan.summary?.grandTotalCost === 'number');
  const previewPlanId = r.data.plan.planId;
  console.log(`  计划ID: ${previewPlanId}`);
  console.log(`  总预算估计: ¥${r.data.plan.summary?.grandTotalCost}`);
  console.log('');

  console.log('【5】重算/生成正式计划');
  r = await api('POST', `/api/subscription/${uid}/plan/recalculate`, {});
  check('生成成功', r.status === 200 && r.code === 0);
  const savedPlanId = r.data?.plan?.planId;
  check('返回保存的 planId', !!savedPlanId);
  check('version >= 1', r.data?.plan?.version >= 1);
  console.log(`  已保存计划: ${savedPlanId} v${r.data?.plan?.version}`);
  console.log('');

  console.log('【6】查询计划列表');
  r = await api('GET', `/api/subscription/${uid}/plans`);
  check('返回至少 1 条计划', r.data?.totalCount >= 1, `count=${r.data?.totalCount}`);
  check('plans 是数组', Array.isArray(r.data?.plans));
  console.log('');

  console.log('【7】获取单条计划详情');
  r = await api('GET', `/api/subscription/${uid}/plans/${savedPlanId}`);
  check('计划详情可查询', r.status === 200 && r.code === 0);
  check('planId 匹配', r.data?.plan?.planId === savedPlanId);
  console.log('');

  console.log('【8】生成第二个计划用于版本对比');
  await api('PUT', `/api/subscription/${uid}/config`, { globalMaxBudget: 500, cyclesAhead: 3 });
  r = await api('POST', `/api/subscription/${uid}/plan/recalculate`, { basePlanId: savedPlanId });
  const planIdB = r.data?.plan?.planId;
  check('生成第二版计划成功', !!planIdB);
  console.log(`  第二版计划: ${planIdB} v${r.data?.plan?.version}`);
  console.log('');

  console.log('【9】版本对比');
  r = await api('GET', `/api/subscription/${uid}/plans/compare?planIdA=${savedPlanId}&planIdB=${planIdB}`);
  check('对比接口返回成功', r.status === 200 && r.code === 0);
  check('包含 metadata', !!r.data?.comparison?.metadata);
  check('包含 summaryDiff', !!r.data?.comparison?.summaryDiff);
  check('包含 cycleDiffs', Array.isArray(r.data?.comparison?.cycleDiffs));
  console.log(`  成本差异: ¥${r.data?.comparison?.summaryDiff?.costDelta}`);
  console.log('');

  console.log('【10】确认计划');
  r = await api('POST', `/api/subscription/${uid}/plans/${savedPlanId}/confirm`);
  check('确认成功', r.status === 200 && r.code === 0);
  check('返回 confirmed 状态', r.data?.status === 'confirmed');
  check('返回 confirmedAt', !!r.data?.confirmedAt);
  console.log('');

  console.log('【11】取消第二个计划');
  r = await api('POST', `/api/subscription/${uid}/plans/${planIdB}/cancel`, { reason: '不需要了' });
  check('取消成功', r.status === 200 && r.code === 0);
  check('状态为 cancelled', r.data?.status === 'cancelled');
  check('取消原因记录', r.data?.cancelReason === '不需要了');
  console.log('');

  console.log('【12】补录历史数据（不污染周期锚点）');
  const prePref = await api('GET', `/api/preference/${uid}`);
  const anchorBefore = prePref.data?.lastMenstrualReported;
  console.log(`  补录前 lastMenstrualReported: ${anchorBefore}`);

  r = await api('POST', '/api/subscription/inventory/backfill', {
    userId: uid, productId: 'sanitary_pad_regular', quantity: 50,
    cyclePhase: 'menstrual', timestamp: daysAgo(120), note: '补录历史数据'
  });
  check('补录成功 HTTP 200', r.status === 200 && r.code === 0);
  check('返回 backfill=true', r.data?.backfill === true);
  check('返回 cycleAnchorNotAffected=true', r.data?.cycleAnchorNotAffected === true);

  const postPref = await api('GET', `/api/preference/${uid}`);
  const anchorAfter = postPref.data?.lastMenstrualReported;
  console.log(`  补录后 lastMenstrualReported: ${anchorAfter}`);
  check('周期锚点未被污染', anchorBefore === anchorAfter, `前=${anchorBefore} 后=${anchorAfter}`);
  console.log('');

  console.log('【13】统一响应格式验证 {code, message, data}');
  const endpoints = [
    ['GET', '/'],
    ['GET', `/api/forecast/${uid}`],
    ['GET', `/api/recommendation/${uid}?cycles=2`],
    ['GET', `/api/preference/${uid}`],
    ['GET', `/api/subscription/${uid}/config`],
    ['GET', `/api/subscription/${uid}/plans`]
  ];
  let allOk = true;
  for (const [m, p] of endpoints) {
    const rr = await api(m, p);
    if (rr.code === undefined || rr.message === undefined || rr.data === undefined) {
      console.log(`  ✗ ${m} ${p} 缺少字段: code=${rr.code} msg=${rr.message} data=${rr.data}`);
      allOk = false;
    }
  }
  check('所有接口统一返回 {code, message, data}', allOk);
  console.log('');

  console.log('【14】验证事件持久化文件存在');
  const fs = require('fs');
  check('events.jsonl 存在', fs.existsSync('./data/events.jsonl'));
  const eventLines = fs.readFileSync('./data/events.jsonl', 'utf8').split('\n').filter(l => l.trim());
  check('事件日志有记录', eventLines.length > 0, `共 ${eventLines.length} 条事件`);
  console.log(`  事件日志条数: ${eventLines.length}`);
  console.log('');

  console.log('========== 全部新功能测试完成 ==========');
}

test().catch(err => { console.error(err); process.exit(1); });
