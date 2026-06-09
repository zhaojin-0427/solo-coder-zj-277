const BASE = 'http://localhost:3000';

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  const data = await res.json();
  return { status: res.status, ...data };
}

function check(name, cond, detail) {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ' - ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

async function test() {
  console.log('\n========== 家庭共享库存协作模块验证 ==========\n');

  const uid1 = 'alice_' + Date.now();
  const uid2 = 'bob_' + Date.now();
  const uid3 = 'carol_' + Date.now();

  console.log('【1】创建共享空间');
  let r = await api('POST', '/api/sharing/spaces', {
    name: '家庭共享测试',
    description: '自动化测试空间',
    ownerId: uid1,
    settings: { budgetSplitStrategy: 'consumption_based' }
  });
  check('创建返回 code=0', r.code === 0, `实际=${r.code}`);
  const spaceId = r.data?.spaceId;
  check('spaceId 已生成', !!spaceId);
  console.log(`    spaceId = ${spaceId}`);

  console.log('\n【2】获取用户空间列表');
  r = await api('GET', `/api/sharing/spaces/user/${uid1}`);
  check('列表返回 code=0', r.code === 0);
  check('列表包含刚创建的空间', (r.data?.spaces || []).some(s => s.id === spaceId));

  console.log('\n【3】邀请成员 Bob');
  r = await api('POST', `/api/sharing/spaces/${spaceId}/members/invite`, {
    inviterId: uid1, userId: uid2, role: 'collaborator', weight: 1.5
  });
  check('邀请返回 code=0', r.code === 0);
  check('返回 inviteCode', !!r.data?.inviteCode);
  const inviteCode = r.data.inviteCode;
  console.log(`    inviteCode = ${inviteCode}`);

  console.log('\n【4】Bob 加入空间');
  r = await api('POST', `/api/sharing/spaces/${spaceId}/members/join`, {
    userId: uid2, inviteCode
  });
  check('加入返回 code=0', r.code === 0);
  check('加入后状态为 active', r.data?.status === 'active');

  console.log('\n【5】邀请 Carol');
  r = await api('POST', `/api/sharing/spaces/${spaceId}/members/invite`, {
    inviterId: uid1, userId: uid3, role: 'viewer'
  });
  const carolCode = r.data?.inviteCode;
  await api('POST', `/api/sharing/spaces/${spaceId}/members/join`, { userId: uid3, inviteCode: carolCode });

  console.log('\n【6】Alice 上报消耗记录（sanitary_pad_regular）');
  r = await api('POST', `/api/sharing/spaces/${spaceId}/records`, {
    userId: uid1, type: 'consumption', productId: 'sanitary_pad_regular',
    quantity: 20, cyclePhase: 'menstrual'
  });
  check('消耗上报返回 code=0', r.code === 0, r.message);
  check('返回 recordId', !!r.data?.recordId);
  check('非补录状态', r.data?.backfill !== true);

  console.log('\n【7】Bob 上报代购记录');
  r = await api('POST', `/api/sharing/spaces/${spaceId}/records`, {
    userId: uid2, type: 'purchase', productId: 'sanitary_pad_regular',
    quantity: 30, amount: 45.0, note: 'Bob帮忙代购'
  });
  check('代购上报返回 code=0', r.code === 0);

  console.log('\n【8】Alice 再上报消耗记录');
  await api('POST', `/api/sharing/spaces/${spaceId}/records`, {
    userId: uid1, type: 'consumption', productId: 'sanitary_pad_regular',
    quantity: 10, cyclePhase: 'menstrual'
  });
  await api('POST', `/api/sharing/spaces/${spaceId}/records`, {
    userId: uid2, type: 'consumption', productId: 'sanitary_pad_regular',
    quantity: 15
  });

  console.log('\n【9】上报借用记录（Alice借Bob）');
  r = await api('POST', `/api/sharing/spaces/${spaceId}/records`, {
    userId: uid1, type: 'borrow', productId: 'tampon_regular',
    quantity: 5, borrowedFrom: uid2, borrowedTo: uid1
  });
  check('借用上报返回 code=0', r.code === 0);
  const borrowId = r.data?.recordId;

  console.log('\n【10】共享库存视图');
  r = await api('GET', `/api/sharing/spaces/${spaceId}/inventory?userId=${uid1}`);
  check('库存视图返回 code=0', r.code === 0);
  check('包含 sanitary_pad_regular', (r.data?.products || []).some(p => p.productId === 'sanitary_pad_regular'));
  const inv = (r.data?.products || []).find(p => p.productId === 'sanitary_pad_regular');
  if (inv) console.log(`    sanitary_pad_regular: 消耗=${inv.totalConsumed}, 代购=${inv.totalPurchased}, 当前库存=${inv.currentStock}`);

  console.log('\n【11】成员贡献聚合');
  r = await api('GET', `/api/sharing/spaces/${spaceId}/aggregation?userId=${uid1}`);
  check('聚合返回 code=0', r.code === 0);
  check('包含 strategy=consumption_based', r.data?.aggregation?.strategy === 'consumption_based');
  console.log(`    总消费金额: ¥${r.data?.aggregation?.totalConsumptionValue}`);
  console.log(`    总代购金额: ¥${r.data?.aggregation?.totalPurchaseAmount}`);

  console.log('\n【12】生成协作采购方案');
  r = await api('POST', `/api/sharing/spaces/${spaceId}/plans/generate`, { userId: uid1, cyclesAhead: 1 });
  check('采购方案返回 code=0', r.code === 0);
  check('planId 已生成', !!r.data?.plan?.planId);
  const planId = r.data?.plan?.planId;
  console.log(`    planId = ${planId}`);
  console.log(`    需购产品数: ${r.data?.plan?.summary?.totalItems}`);
  console.log(`    预估总成本: ¥${r.data?.plan?.summary?.grandTotalCost}`);
  if (r.data?.plan?.items?.[0]) {
    const item = r.data.plan.items[0];
    console.log(`    首个产品: ${item.productName}, 购买=${item.packsToBuy}包, 分配购买人=${item.assignedBuyer}`);
  }

  console.log('\n【13】确认采购方案');
  r = await api('POST', `/api/sharing/spaces/${spaceId}/plans/${planId}/confirm`, { userId: uid1 });
  check('确认方案返回 code=0', r.code === 0);
  check('状态为 confirmed', r.data?.status === 'confirmed');

  console.log('\n【14】生成代购结算账单');
  r = await api('POST', `/api/sharing/spaces/${spaceId}/bills/generate`, { userId: uid1 });
  check('结算账单返回 code=0', r.code === 0);
  check('billId 已生成', !!r.data?.billId);
  console.log(`    billId = ${r.data?.billId}`);
  console.log(`    结算笔数: ${r.data?.bill?.summary?.settlementTransactionCount}`);
  console.log(`    需结算: ${r.data?.bill?.summary?.needsSettlement}`);
  if (r.data?.bill?.settlementTransactions?.length) {
    r.data.bill.settlementTransactions.forEach(t => {
      console.log(`      ${t.fromUserId} → ${t.toUserId}: ¥${t.amount}`);
    });
  }

  console.log('\n【15】查询操作冲突');
  r = await api('GET', `/api/sharing/spaces/${spaceId}/conflicts?userId=${uid1}`);
  check('冲突查询返回 code=0', r.code === 0);

  console.log('\n【16】历史版本快照列表');
  r = await api('GET', `/api/sharing/spaces/${spaceId}/versions?userId=${uid1}`);
  check('版本列表返回 code=0', r.code === 0);
  check('存在版本记录', (r.data?.versions || []).length > 0);
  console.log(`    当前版本: v${r.data?.currentVersion}, 总版本数: ${r.data?.totalVersions}`);

  console.log('\n【17】回滚预览');
  const targetVer = 1;
  r = await api('GET', `/api/sharing/spaces/${spaceId}/versions/rollback-preview?userId=${uid1}&toVersion=${targetVer}`);
  check('回滚预览返回 code=0', r.code === 0);

  console.log('\n【18】补录历史数据（验证不污染周期锚点）');
  const pastDate = new Date(Date.now() - 30 * 86400000).toISOString();
  r = await api('POST', `/api/sharing/spaces/${spaceId}/records/backfill`, {
    userId: uid2, type: 'consumption', productId: 'sanitary_pad_night',
    quantity: 8, cyclePhase: 'menstrual', timestamp: pastDate
  });
  check('补录返回 code=0', r.code === 0);
  check('backfill=true', r.data?.backfill === true);
  check('cycleAnchorNotAffected=true', r.data?.cycleAnchorNotAffected === true);

  console.log('\n【19】权限验证：viewer 不能上报记录');
  r = await api('POST', `/api/sharing/spaces/${spaceId}/records`, {
    userId: uid3, type: 'consumption', productId: 'sanitary_pad_regular', quantity: 5
  });
  check('viewer 上报被拒绝（code≠0）', r.code !== 0);

  console.log('\n【20】查看空间详情（完整成员列表）');
  r = await api('GET', `/api/sharing/spaces/${spaceId}?userId=${uid1}`);
  check('详情返回 code=0', r.code === 0);
  check('3 个活跃成员', r.data?.members?.filter(m => m.status === 'active').length === 3);

  console.log('\n========== 家庭共享库存协作模块验证完成 ==========\n');
}

test().catch(err => { console.error(err); process.exit(1); });
