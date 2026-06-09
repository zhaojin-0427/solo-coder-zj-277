const { success, badRequest, error, notFound } = require('../utils/response');
const {
  createSharedSpace,
  updateSharedSpace,
  deleteSharedSpace,
  getSharedSpace,
  getSharedSpacesByUser,
  getMembers,
  getActiveMembers,
  getMemberRole,
  inviteMember,
  joinSharedSpace,
  leaveSharedSpace,
  removeMember,
  updateMember,
  addSharedSpaceRecord,
  getSharedSpaceRecords,
  saveSharedSpacePlan,
  confirmSharedSpacePlan,
  getSharedSpacePlans,
  getSharedSpacePlanById,
  settleSharedSpaceBill,
  getSharedSpaceBills,
  addSharedSpaceConflict,
  resolveSharedSpaceConflict,
  getSharedSpaceConflicts,
  createSharedSpaceSnapshot,
  getSharedSpaceSnapshots,
  rollbackSharedSpace,
  getProduct,
  getAllProducts,
  cyclePhases,
  generatePlanId,
  generateBillId,
  getReportsByUser
} = require('../models/store');
const { calculateConsumptionRate, calculateStockWarningDays, extrapolateCurrentStock } = require('../utils/consumption');
const { daysBetween, todayISO, addDays, formatDate } = require('../utils/date');

const MEMBER_ROLES = ['owner', 'admin', 'collaborator', 'viewer'];
const RECORD_TYPES = ['consumption', 'purchase', 'borrow', 'return', 'preference'];
const BUDGET_STRATEGIES = ['equal', 'weighted', 'consumption_based', 'purchase_based'];

function isValidDate(str) {
  if (!str) return true;
  if (typeof str !== 'string') return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

function requireSpaceAccess(spaceId, userId, minRole = 'viewer') {
  const space = getSharedSpace(spaceId);
  if (!space) return { error: '共享空间不存在', code: 404 };
  if (space.status !== 'active') return { error: '共享空间已停用', code: 400 };
  const role = getMemberRole(spaceId, userId);
  if (!role) return { error: '非空间成员，无权访问', code: 403 };
  const roleRank = { viewer: 0, collaborator: 1, admin: 2, owner: 3 };
  if ((roleRank[role] || 0) < (roleRank[minRole] || 0)) {
    return { error: `权限不足，需要 ${minRole} 及以上角色`, code: 403 };
  }
  return { space, role };
}

function createSpace(req, res) {
  try {
    const { name, description, ownerId, settings } = req.body;
    if (!name || !ownerId) return badRequest('缺少必要参数：name, ownerId', null, res);
    if (typeof name !== 'string' || name.trim().length === 0) return badRequest('name 不能为空', null, res);

    const spaceData = {
      name: name.trim(),
      description: description || null,
      ownerId,
      settings: settings || {
        budgetSplitStrategy: 'equal',
        autoSettlement: false,
        settlementCycleDays: 30
      }
    };

    if (spaceData.settings.budgetSplitStrategy && !BUDGET_STRATEGIES.includes(spaceData.settings.budgetSplitStrategy)) {
      return badRequest(`budgetSplitStrategy 必须是: ${BUDGET_STRATEGIES.join(', ')}`, null, res);
    }

    const space = createSharedSpace(spaceData);
    return success({ spaceId: space.id, space }, '共享空间创建成功', res);
  } catch (err) {
    console.error('createSpace error:', err);
    return error('创建共享空间失败：' + err.message, 500, null, res);
  }
}

function updateSpace(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId, name, description, settings } = req.body;
    if (!spaceId || !userId) return badRequest('缺少必要参数：spaceId, userId', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'admin');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const updates = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) return badRequest('name 不能为空', null, res);
      updates.name = name.trim();
    }
    if (description !== undefined) updates.description = description;
    if (settings !== undefined) {
      if (settings.budgetSplitStrategy && !BUDGET_STRATEGIES.includes(settings.budgetSplitStrategy)) {
        return badRequest(`budgetSplitStrategy 必须是: ${BUDGET_STRATEGIES.join(', ')}`, null, res);
      }
      updates.settings = { ...access.space.settings, ...settings };
    }

    if (Object.keys(updates).length === 0) return badRequest('没有提供任何可更新的字段', null, res);
    const space = updateSharedSpace(spaceId, updates);
    return success({ space }, '共享空间更新成功', res);
  } catch (err) {
    console.error('updateSpace error:', err);
    return error('更新共享空间失败：' + err.message, 500, null, res);
  }
}

function deleteSpace(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId } = req.body;
    if (!spaceId || !userId) return badRequest('缺少必要参数：spaceId, userId', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'owner');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const ok = deleteSharedSpace(spaceId);
    return success({ spaceId, deleted: ok }, '共享空间删除成功', res);
  } catch (err) {
    console.error('deleteSpace error:', err);
    return error('删除共享空间失败：' + err.message, 500, null, res);
  }
}

function getSpace(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId } = req.query;
    if (!spaceId || !userId) return badRequest('缺少必要参数：spaceId, userId', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'viewer');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const members = getMembers(spaceId);
    return success({
      space: access.space,
      memberCount: members.filter(m => m.status === 'active').length,
      members: members.map(m => ({
        userId: m.userId,
        role: m.role,
        status: m.status,
        joinedAt: m.joinedAt,
        weight: m.weight || 1,
        cycleAnchor: m.cycleAnchor || null
      }))
    }, '查询成功', res);
  } catch (err) {
    console.error('getSpace error:', err);
    return error('查询共享空间失败：' + err.message, 500, null, res);
  }
}

function listUserSpaces(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) return badRequest('缺少 userId 参数', null, res);

    const spaces = getSharedSpacesByUser(userId);
    const spacesWithMemberCount = spaces.map(space => {
      const members = getMembers(space.id);
      return {
        ...space,
        memberCount: members.filter(m => m.status === 'active').length
      };
    });
    return success({ userId, totalCount: spaces.length, spaces: spacesWithMemberCount }, '查询成功', res);
  } catch (err) {
    console.error('listUserSpaces error:', err);
    return error('查询用户空间列表失败：' + err.message, 500, null, res);
  }
}

function inviteSpaceMember(req, res) {
  try {
    const { spaceId } = req.params;
    const { inviterId, userId, role, weight } = req.body;
    if (!spaceId || !inviterId || !userId) return badRequest('缺少必要参数：spaceId, inviterId, userId', null, res);

    const access = requireSpaceAccess(spaceId, inviterId, 'admin');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    if (role && !MEMBER_ROLES.includes(role)) return badRequest(`role 必须是: ${MEMBER_ROLES.join(', ')}`, null, res);
    if (role === 'owner') return badRequest('不能邀请其他 owner', null, res);

    const existingMembers = getMembers(spaceId);
    if (existingMembers.find(m => m.userId === userId && m.status === 'active')) {
      return badRequest('该用户已是空间成员', null, res);
    }

    const member = inviteMember(spaceId, { userId, role: role || 'collaborator', invitedBy: inviterId, weight });
    return success({
      userId: member.userId,
      role: member.role,
      inviteCode: member.inviteCode,
      status: member.status
    }, '成员邀请成功', res);
  } catch (err) {
    console.error('inviteSpaceMember error:', err);
    return error('邀请成员失败：' + err.message, 500, null, res);
  }
}

function joinSpace(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId, inviteCode } = req.body;
    if (!spaceId || !userId) return badRequest('缺少必要参数：spaceId, userId', null, res);

    const space = getSharedSpace(spaceId);
    if (!space) return notFound('共享空间不存在', null, res);
    if (space.status !== 'active') return badRequest('共享空间已停用', null, res);

    const member = joinSharedSpace(spaceId, userId, inviteCode);
    return success({
      userId: member.userId,
      role: member.role,
      status: member.status,
      joinedAt: member.joinedAt
    }, '加入共享空间成功', res);
  } catch (err) {
    console.error('joinSpace error:', err);
    return error('加入共享空间失败：' + err.message, 500, null, res);
  }
}

function leaveSpace(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId } = req.body;
    if (!spaceId || !userId) return badRequest('缺少必要参数：spaceId, userId', null, res);

    const role = getMemberRole(spaceId, userId);
    if (!role) return badRequest('非空间成员', null, res);
    if (role === 'owner') return badRequest('空间所有者不能退出，请先转让所有权或删除空间', null, res);

    const member = leaveSharedSpace(spaceId, userId);
    return success({ userId: member.userId, status: member.status, leftAt: member.leftAt }, '退出共享空间成功', res);
  } catch (err) {
    console.error('leaveSpace error:', err);
    return error('退出共享空间失败：' + err.message, 500, null, res);
  }
}

function removeSpaceMember(req, res) {
  try {
    const { spaceId } = req.params;
    const { operatorId, userId } = req.body;
    if (!spaceId || !operatorId || !userId) return badRequest('缺少必要参数：spaceId, operatorId, userId', null, res);

    const access = requireSpaceAccess(spaceId, operatorId, 'admin');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const targetRole = getMemberRole(spaceId, userId);
    if (!targetRole) return badRequest('目标用户不是空间成员', null, res);
    if (targetRole === 'owner') return badRequest('不能移除空间所有者', null, res);

    const operatorRole = access.role;
    const roleRank = { viewer: 0, collaborator: 1, admin: 2, owner: 3 };
    if (roleRank[operatorRole] <= roleRank[targetRole] && operatorRole !== 'owner') {
      return badRequest('权限不足：只能移除角色等级低于自己的成员', null, res);
    }

    const member = removeMember(spaceId, userId, operatorId);
    return success({ userId: member.userId, status: member.status, removedAt: member.removedAt }, '成员已移除', res);
  } catch (err) {
    console.error('removeSpaceMember error:', err);
    return error('移除成员失败：' + err.message, 500, null, res);
  }
}

function updateSpaceMember(req, res) {
  try {
    const { spaceId } = req.params;
    const { operatorId, userId, role, weight } = req.body;
    if (!spaceId || !operatorId || !userId) return badRequest('缺少必要参数：spaceId, operatorId, userId', null, res);

    const access = requireSpaceAccess(spaceId, operatorId, 'admin');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    if (role && !MEMBER_ROLES.includes(role)) return badRequest(`role 必须是: ${MEMBER_ROLES.join(', ')}`, null, res);
    if (role === 'owner') return badRequest('不能将其他用户设为 owner', null, res);

    const targetRole = getMemberRole(spaceId, userId);
    if (!targetRole) return badRequest('目标用户不是空间成员', null, res);

    const updates = {};
    if (role !== undefined) updates.role = role;
    if (weight !== undefined) {
      if (typeof weight !== 'number' || weight <= 0) return badRequest('weight 必须是正数', null, res);
      updates.weight = weight;
    }

    if (Object.keys(updates).length === 0) return badRequest('没有提供任何可更新的字段', null, res);
    const member = updateMember(spaceId, userId, updates);
    return success({ userId: member.userId, role: member.role, weight: member.weight || 1 }, '成员信息更新成功', res);
  } catch (err) {
    console.error('updateSpaceMember error:', err);
    return error('更新成员信息失败：' + err.message, 500, null, res);
  }
}

function reportRecord(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId, type, productId, quantity, cyclePhase, timestamp, note, amount, borrowedFrom, borrowedTo, borrowId, preference } = req.body;

    if (!spaceId || !userId || !type) return badRequest('缺少必要参数：spaceId, userId, type', null, res);
    if (!RECORD_TYPES.includes(type)) return badRequest(`type 必须是: ${RECORD_TYPES.join(', ')}`, null, res);

    const access = requireSpaceAccess(spaceId, userId, 'collaborator');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const needsProduct = ['consumption', 'purchase', 'borrow', 'return'];
    if (needsProduct.includes(type)) {
      if (!productId || quantity === undefined || quantity === null) {
        return badRequest(`${type} 类型需要 productId 和 quantity`, null, res);
      }
      if (typeof quantity !== 'number' || quantity < 0) return badRequest('quantity 必须是非负数字', null, res);
      if (!getProduct(productId)) return badRequest(`产品ID不存在: ${productId}`, null, res);
    }

    if (cyclePhase && !cyclePhases.includes(cyclePhase)) {
      return badRequest(`cyclePhase 必须是: ${cyclePhases.join(', ')}`, null, res);
    }

    if (timestamp !== undefined && timestamp !== null && !isValidDate(timestamp)) {
      return badRequest('timestamp 必须是合法的 ISO 日期字符串', null, res);
    }

    if (timestamp) {
      const reportDate = new Date(timestamp);
      const now = new Date();
      if (reportDate.getTime() > now.getTime() + 60 * 1000) {
        return badRequest('timestamp 不能是未来时间', null, res);
      }
    }

    if (type === 'purchase') {
      if (amount === undefined || amount === null || typeof amount !== 'number' || amount < 0) {
        return badRequest('purchase 类型需要非负 amount（总金额）', null, res);
      }
    }

    if (type === 'borrow') {
      if (!borrowedFrom || !borrowedTo) return badRequest('borrow 类型需要 borrowedFrom 和 borrowedTo', null, res);
    }

    if (type === 'return' && borrowId) {
      const records = getSharedSpaceRecords(spaceId, { type: 'borrow', status: 'active' });
      const borrow = records.find(r => r.id === borrowId);
      if (!borrow) return badRequest(`borrowId 不存在或已归还: ${borrowId}`, null, res);
    }

    const isBackfill = timestamp && daysBetween(timestamp, todayISO()) > 1;
    const recordData = {
      userId,
      productId: productId || null,
      quantity: quantity !== undefined ? quantity : null,
      cyclePhase: cyclePhase || null,
      timestamp: timestamp || new Date().toISOString(),
      note: note || null,
      amount: amount !== undefined ? amount : null,
      borrowedFrom: borrowedFrom || null,
      borrowedTo: borrowedTo || null,
      borrowId: borrowId || null,
      preference: preference || null
    };

    const opts = isBackfill ? { backfill: true, source: 'backfill' } : {};
    const record = addSharedSpaceRecord(spaceId, recordData, type, opts);

    const conflicts = detectConflicts(spaceId, record, type);
    let detectedConflicts = [];
    if (conflicts.length > 0) {
      detectedConflicts = conflicts.map(c => addSharedSpaceConflict(spaceId, c));
    }

    return success({
      recordId: record.id,
      type: record.type,
      productName: productId ? getProduct(productId)?.name || null : null,
      backfill: isBackfill,
      cycleAnchorNotAffected: isBackfill && type === 'consumption',
      conflictsDetected: detectedConflicts.length,
      conflicts: detectedConflicts
    }, `${type === 'consumption' ? '消耗' : type === 'purchase' ? '代购' : type === 'borrow' ? '借用' : type === 'return' ? '归还' : '偏好'}记录上报成功`, res);
  } catch (err) {
    console.error('reportRecord error:', err);
    return error('记录上报失败：' + err.message, 500, null, res);
  }
}

function detectConflicts(spaceId, newRecord, type) {
  const conflicts = [];
  const records = getSharedSpaceRecords(spaceId);
  const now = new Date();

  if (type === 'consumption') {
    const sameWindow = records.filter(r =>
      r.type === 'consumption' &&
      r.productId === newRecord.productId &&
      r.userId !== newRecord.userId &&
      Math.abs(daysBetween(r.timestamp, newRecord.timestamp)) <= 1
    );
    if (sameWindow.length > 0) {
      conflicts.push({
        type: 'overlapping_consumption',
        severity: 'low',
        description: `检测到 ${sameWindow.length} 条同产品同时间窗口的其他成员消耗记录，建议核对`,
        relatedRecordIds: sameWindow.map(r => r.id),
        productId: newRecord.productId
      });
    }
  }

  if (type === 'purchase') {
    const recentPurchases = records.filter(r =>
      r.type === 'purchase' &&
      r.productId === newRecord.productId &&
      daysBetween(r.timestamp, now.toISOString()) <= 7
    );
    if (recentPurchases.length >= 2) {
      conflicts.push({
        type: 'duplicate_purchase_risk',
        severity: 'medium',
        description: `7天内已有 ${recentPurchases.length} 笔 ${newRecord.productId} 代购记录，存在重复采购风险`,
        relatedRecordIds: recentPurchases.map(r => r.id),
        productId: newRecord.productId
      });
    }
  }

  if (type === 'borrow') {
    const activeBorrows = records.filter(r =>
      r.type === 'borrow' &&
      r.status === 'active' &&
      (r.borrowedFrom === newRecord.borrowedTo || r.borrowedTo === newRecord.borrowedFrom)
    );
    if (activeBorrows.length >= 3) {
      conflicts.push({
        type: 'multiple_active_borrows',
        severity: 'low',
        description: `相关用户之间有 ${activeBorrows.length} 笔未归还借用，建议结算`,
        relatedRecordIds: activeBorrows.map(r => r.id)
      });
    }
  }

  return conflicts;
}

function getSpaceInventoryView(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId } = req.query;
    if (!spaceId || !userId) return badRequest('缺少必要参数：spaceId, userId', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'viewer');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const records = getSharedSpaceRecords(spaceId);
    const members = getActiveMembers(spaceId);

    const productAggregation = {};
    const memberAggregation = {};

    members.forEach(m => {
      memberAggregation[m.userId] = {
        userId: m.userId,
        role: m.role,
        weight: m.weight || 1,
        totalConsumed: 0,
        totalPurchased: 0,
        totalPurchaseAmount: 0,
        borrowBalance: 0,
        consumptionByProduct: {}
      };
    });

    getAllProducts().forEach(p => {
      productAggregation[p.id] = {
        productId: p.id,
        productName: p.name,
        unit: p.unit,
        avgPricePerUnit: p.avgPricePerUnit,
        totalConsumed: 0,
        totalPurchased: 0,
        currentStock: 0,
        consumptionByMember: {},
        purchaseByMember: {},
        lastReport: null
      };
    });

    records.forEach(r => {
      if (!productAggregation[r.productId]) return;
      const pa = productAggregation[r.productId];

      if (r.type === 'consumption') {
        pa.totalConsumed += r.quantity || 0;
        pa.currentStock -= r.quantity || 0;
        if (!pa.consumptionByMember[r.userId]) pa.consumptionByMember[r.userId] = 0;
        pa.consumptionByMember[r.userId] += r.quantity || 0;
        pa.lastReport = r;
        if (memberAggregation[r.userId]) {
          memberAggregation[r.userId].totalConsumed += r.quantity || 0;
          if (!memberAggregation[r.userId].consumptionByProduct[r.productId]) {
            memberAggregation[r.userId].consumptionByProduct[r.productId] = 0;
          }
          memberAggregation[r.userId].consumptionByProduct[r.productId] += r.quantity || 0;
        }
      } else if (r.type === 'purchase') {
        pa.totalPurchased += r.quantity || 0;
        pa.currentStock += r.quantity || 0;
        if (!pa.purchaseByMember[r.userId]) pa.purchaseByMember[r.userId] = 0;
        pa.purchaseByMember[r.userId] += r.quantity || 0;
        pa.lastReport = r;
        if (memberAggregation[r.userId]) {
          memberAggregation[r.userId].totalPurchased += r.quantity || 0;
          memberAggregation[r.userId].totalPurchaseAmount += r.amount || 0;
        }
      }
    });

    const products = Object.values(productAggregation).filter(p => p.totalConsumed > 0 || p.totalPurchased > 0 || p.currentStock !== 0);

    return success({
      spaceId,
      generatedAt: todayISO(),
      summary: {
        totalProducts: products.length,
        totalActiveMembers: members.length,
        totalRecords: records.length
      },
      products: products.map(p => ({
        ...p,
        currentStock: Math.max(0, p.currentStock),
        stockDaysLeft: p.currentStock > 0 ? '充足' : 0
      })),
      memberContributions: Object.values(memberAggregation)
    }, '共享库存视图生成成功', res);
  } catch (err) {
    console.error('getSpaceInventoryView error:', err);
    return error('获取共享库存视图失败：' + err.message, 500, null, res);
  }
}

function calculateAggregation(spaceId) {
  const records = getSharedSpaceRecords(spaceId);
  const members = getActiveMembers(spaceId);
  const space = getSharedSpace(spaceId);
  const strategy = space?.settings?.budgetSplitStrategy || 'equal';

  const memberConsumption = {};
  const memberPurchaseAmount = {};
  const memberWeight = {};
  const productConsumption = {};
  const productConsumptionByMember = {};

  members.forEach(m => {
    memberConsumption[m.userId] = 0;
    memberPurchaseAmount[m.userId] = 0;
    memberWeight[m.userId] = m.weight || 1;
  });

  records.forEach(r => {
    if (r.type === 'consumption' && memberConsumption[r.userId] !== undefined) {
      const product = getProduct(r.productId);
      const value = (r.quantity || 0) * (product?.avgPricePerUnit || 0);
      memberConsumption[r.userId] += value;
      if (!productConsumption[r.productId]) productConsumption[r.productId] = 0;
      productConsumption[r.productId] += r.quantity || 0;
      if (!productConsumptionByMember[r.productId]) productConsumptionByMember[r.productId] = {};
      if (!productConsumptionByMember[r.productId][r.userId]) productConsumptionByMember[r.productId][r.userId] = 0;
      productConsumptionByMember[r.productId][r.userId] += r.quantity || 0;
    } else if (r.type === 'purchase' && memberPurchaseAmount[r.userId] !== undefined) {
      memberPurchaseAmount[r.userId] += r.amount || 0;
    }
  });

  const totalConsumptionValue = Object.values(memberConsumption).reduce((s, v) => s + v, 0);
  const totalPurchaseAmount = Object.values(memberPurchaseAmount).reduce((s, v) => s + v, 0);
  const totalWeight = Object.values(memberWeight).reduce((s, v) => s + v, 0);

  const memberShare = {};
  if (strategy === 'equal') {
    const n = members.length || 1;
    members.forEach(m => { memberShare[m.userId] = totalPurchaseAmount / n; });
  } else if (strategy === 'weighted') {
    members.forEach(m => {
      memberShare[m.userId] = totalPurchaseAmount * ((memberWeight[m.userId] || 1) / (totalWeight || 1));
    });
  } else if (strategy === 'consumption_based') {
    members.forEach(m => {
      const ratio = totalConsumptionValue > 0 ? memberConsumption[m.userId] / totalConsumptionValue : 1 / (members.length || 1);
      memberShare[m.userId] = totalPurchaseAmount * ratio;
    });
  } else if (strategy === 'purchase_based') {
    members.forEach(m => { memberShare[m.userId] = memberPurchaseAmount[m.userId]; });
  }

  const memberSettlement = {};
  members.forEach(m => {
    const paid = memberPurchaseAmount[m.userId];
    const owed = memberShare[m.userId];
    memberSettlement[m.userId] = {
      userId: m.userId,
      role: m.role,
      consumptionValue: Number(memberConsumption[m.userId].toFixed(2)),
      paidAmount: Number(paid.toFixed(2)),
      sharedObligation: Number(owed.toFixed(2)),
      netBalance: Number((paid - owed).toFixed(2)),
      shouldReceive: Number(Math.max(0, paid - owed).toFixed(2)),
      shouldPay: Number(Math.max(0, owed - paid).toFixed(2)),
      needsSettlement: Math.abs(paid - owed) >= 0.01
    };
  });

  return {
    spaceId,
    strategy,
    totalConsumptionValue: Number(totalConsumptionValue.toFixed(2)),
    totalPurchaseAmount: Number(totalPurchaseAmount.toFixed(2)),
    productConsumption,
    productConsumptionByMember,
    memberConsumption,
    memberPurchaseAmount,
    memberShare,
    memberSettlement
  };
}

function getAggregation(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId } = req.query;
    if (!spaceId || !userId) return badRequest('缺少必要参数：spaceId, userId', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'viewer');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const agg = calculateAggregation(spaceId);
    return success({ aggregation: agg }, '成员贡献聚合查询成功', res);
  } catch (err) {
    console.error('getAggregation error:', err);
    return error('获取聚合数据失败：' + err.message, 500, null, res);
  }
}

function generateProcurementPlan(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId, cyclesAhead } = req.body;
    if (!spaceId || !userId) return badRequest('缺少必要参数：spaceId, userId', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'collaborator');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const agg = calculateAggregation(spaceId);
    const records = getSharedSpaceRecords(spaceId);
    const members = getActiveMembers(spaceId);
    const cycleLength = 28;
    const effectiveCyclesAhead = (cyclesAhead && Number(cyclesAhead) >= 1) ? Number(cyclesAhead) : 1;

    const planItems = [];
    const products = getAllProducts();

    products.forEach(product => {
      const productRecords = records.filter(r => r.productId === product.id);
      const consumptionRecords = productRecords.filter(r => r.type === 'consumption');

      let currentStock = 0;
      productRecords.forEach(r => {
        if (r.type === 'purchase') currentStock += r.quantity || 0;
        if (r.type === 'consumption') currentStock -= r.quantity || 0;
      });
      currentStock = Math.max(0, currentStock);

      let dailyRate = 0;
      for (let i = 1; i < consumptionRecords.length; i++) {
        const prev = consumptionRecords[i - 1];
        const curr = consumptionRecords[i];
        const days = daysBetween(prev.timestamp, curr.timestamp);
        if (days > 0) {
          const consumed = (prev.quantity || 0) - (curr.quantity || 0);
          if (consumed > 0) dailyRate += consumed / days;
        }
      }
      if (consumptionRecords.length > 1) dailyRate = dailyRate / (consumptionRecords.length - 1);
      dailyRate = Number(dailyRate.toFixed(4));

      const warning = calculateStockWarningDays(currentStock, dailyRate, 3);
      const totalNeed = dailyRate * cycleLength * effectiveCyclesAhead;
      const needToBuy = Math.max(0, Math.ceil(totalNeed - currentStock));
      const packsToBuy = Math.ceil(needToBuy / product.defaultPackSize);
      const totalUnits = packsToBuy * product.defaultPackSize;
      const estimatedCost = Number((totalUnits * product.avgPricePerUnit).toFixed(2));

      const consumptionByMember = agg.productConsumptionByMember[product.id] || {};
      const totalProductConsumption = Object.values(consumptionByMember).reduce((s, v) => s + v, 0);
      const memberResponsibility = {};

      members.forEach(m => {
        const personalConsumption = consumptionByMember[m.userId] || 0;
        const ratio = totalProductConsumption > 0 ? personalConsumption / totalProductConsumption : 1 / (members.length || 1);
        memberResponsibility[m.userId] = {
          userId: m.userId,
          consumedQuantity: personalConsumption,
          responsibilityRatio: Number(ratio.toFixed(4)),
          shouldBuyUnits: Math.ceil(needToBuy * ratio),
          shouldPayAmount: Number((estimatedCost * ratio).toFixed(2))
        };
      });

      let assignedBuyer = null;
      let minNetBalance = Infinity;
      members.forEach(m => {
        const s = agg.memberSettlement[m.userId];
        if (s && s.netBalance < minNetBalance) {
          minNetBalance = s.netBalance;
          assignedBuyer = m.userId;
        }
      });

      const urgency = warning.critical ? 0 : warning.warning ? 1 : 2;
      planItems.push({
        productId: product.id,
        productName: product.name,
        unit: product.unit,
        currentStock,
        dailyConsumption: dailyRate,
        stockDaysLeft: warning.daysLeft === Infinity ? '充足' : warning.daysLeft,
        stockWarning: { isWarning: warning.warning, isCritical: warning.critical },
        needToBuy,
        packsToBuy,
        totalUnits,
        estimatedCost,
        urgencyPriority: urgency,
        urgency: warning.critical ? '立即购买' : warning.warning ? '近期购买' : '正常采购',
        assignedBuyer,
        shouldBuyForMembers: Object.values(memberResponsibility),
        needsSettlement: estimatedCost > 0
      });
    });

    const itemsToBuy = planItems.filter(p => p.packsToBuy > 0).sort((a, b) => a.urgencyPriority - b.urgencyPriority);

    const plan = {
      planId: generatePlanId(),
      spaceId,
      createdAt: todayISO(),
      status: 'draft',
      cyclesAhead: effectiveCyclesAhead,
      generatedBy: userId,
      budgetStrategy: agg.strategy,
      summary: {
        totalItems: itemsToBuy.length,
        grandTotalCost: Number(itemsToBuy.reduce((s, i) => s + i.estimatedCost, 0).toFixed(2)),
        immediatePurchaseCount: itemsToBuy.filter(i => i.urgency === '立即购买').length,
        warningPurchaseCount: itemsToBuy.filter(i => i.urgency === '近期购买').length
      },
      items: itemsToBuy,
      memberSettlementSummary: Object.values(agg.memberSettlement)
    };

    const saved = saveSharedSpacePlan(spaceId, plan);
    const space = getSharedSpace(spaceId);
    const nextVersion = (space?.currentVersion || 1) + 1;
    updateSharedSpace(spaceId, { currentVersion: nextVersion });
    createSharedSpaceSnapshot(spaceId, nextVersion);

    return success({ plan: saved }, '协作采购方案生成成功', res);
  } catch (err) {
    console.error('generateProcurementPlan error:', err);
    return error('生成采购方案失败：' + err.message, 500, null, res);
  }
}

function confirmProcurementPlan(req, res) {
  try {
    const { spaceId, planId } = req.params;
    const { userId } = req.body;
    if (!spaceId || !planId || !userId) return badRequest('缺少必要参数：spaceId, planId, userId', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'admin');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const plan = getSharedSpacePlanById(spaceId, planId);
    if (!plan) return notFound('采购方案不存在', null, res);
    if (plan.status === 'confirmed') return badRequest('方案已确认，无需重复操作', null, res);

    const confirmed = confirmSharedSpacePlan(spaceId, planId, userId);
    return success({ planId: confirmed.planId, status: confirmed.status, confirmedAt: confirmed.confirmedAt, confirmedBy: confirmed.confirmedBy }, '采购方案确认成功', res);
  } catch (err) {
    console.error('confirmProcurementPlan error:', err);
    return error('确认采购方案失败：' + err.message, 500, null, res);
  }
}

function listProcurementPlans(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId, status } = req.query;
    if (!spaceId || !userId) return badRequest('缺少必要参数：spaceId, userId', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'viewer');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    let plans = getSharedSpacePlans(spaceId);
    if (status) plans = plans.filter(p => p.status === status);

    return success({
      spaceId,
      totalCount: plans.length,
      plans: plans.map(p => ({
        planId: p.planId,
        createdAt: p.createdAt,
        status: p.status,
        cyclesAhead: p.cyclesAhead,
        generatedBy: p.generatedBy,
        confirmedAt: p.confirmedAt || null,
        summary: p.summary
      }))
    }, '采购方案列表查询成功', res);
  } catch (err) {
    console.error('listProcurementPlans error:', err);
    return error('查询采购方案列表失败：' + err.message, 500, null, res);
  }
}

function generateSettlementBill(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId, periodStart, periodEnd } = req.body;
    if (!spaceId || !userId) return badRequest('缺少必要参数：spaceId, userId', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'admin');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const agg = calculateAggregation(spaceId);
    const records = getSharedSpaceRecords(spaceId);
    const members = getActiveMembers(spaceId);

    let filteredRecords = records;
    if (periodStart || periodEnd) {
      filteredRecords = records.filter(r => {
        const t = new Date(r.timestamp).getTime();
        if (periodStart && t < new Date(periodStart).getTime()) return false;
        if (periodEnd && t > new Date(periodEnd).getTime()) return false;
        return true;
      });
    }

    const purchaseRecords = filteredRecords.filter(r => r.type === 'purchase');
    const consumptionRecords = filteredRecords.filter(r => r.type === 'consumption');

    const settlements = [];
    const creditors = [];
    const debtors = [];

    Object.values(agg.memberSettlement).forEach(s => {
      if (s.shouldReceive > 0) creditors.push(s);
      if (s.shouldPay > 0) debtors.push(s);
    });

    creditors.sort((a, b) => b.shouldReceive - a.shouldReceive);
    debtors.sort((a, b) => b.shouldPay - a.shouldPay);

    let ci = 0, di = 0;
    while (ci < creditors.length && di < debtors.length) {
      const creditor = creditors[ci];
      const debtor = debtors[di];
      const amount = Number(Math.min(creditor.shouldReceive, debtor.shouldPay).toFixed(2));
      if (amount > 0) {
        settlements.push({
          fromUserId: debtor.userId,
          toUserId: creditor.userId,
          amount,
          description: `${debtor.userId} 应向 ${creditor.userId} 支付 ¥${amount} 结算代购款`
        });
      }
      creditor.shouldReceive = Number((creditor.shouldReceive - amount).toFixed(2));
      debtor.shouldPay = Number((debtor.shouldPay - amount).toFixed(2));
      if (creditor.shouldReceive <= 0.01) ci++;
      if (debtor.shouldPay <= 0.01) di++;
    }

    const bill = {
      billId: generateBillId(),
      spaceId,
      createdAt: todayISO(),
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
      generatedBy: userId,
      strategy: agg.strategy,
      summary: {
        totalPurchaseAmount: Number(purchaseRecords.reduce((s, r) => s + (r.amount || 0), 0).toFixed(2)),
        totalConsumptionValue: agg.totalConsumptionValue,
        memberCount: members.length,
        purchaseCount: purchaseRecords.length,
        consumptionCount: consumptionRecords.length,
        needsSettlement: settlements.length > 0,
        settlementTransactionCount: settlements.length
      },
      memberDetails: Object.values(agg.memberSettlement),
      settlementTransactions: settlements,
      relatedPurchaseRecords: purchaseRecords.map(r => ({
        recordId: r.id,
        userId: r.userId,
        productId: r.productId,
        productName: getProduct(r.productId)?.name || r.productId,
        quantity: r.quantity,
        amount: r.amount,
        timestamp: r.timestamp
      }))
    };

    const saved = settleSharedSpaceBill(spaceId, bill);
    return success({ billId: saved.billId, bill: saved }, '代购结算账单生成成功', res);
  } catch (err) {
    console.error('generateSettlementBill error:', err);
    return error('生成结算账单失败：' + err.message, 500, null, res);
  }
}

function listSettlementBills(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId } = req.query;
    if (!spaceId || !userId) return badRequest('缺少必要参数：spaceId, userId', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'viewer');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const bills = getSharedSpaceBills(spaceId);
    return success({
      spaceId,
      totalCount: bills.length,
      bills: bills.map(b => ({
        billId: b.billId,
        createdAt: b.createdAt,
        periodStart: b.periodStart,
        periodEnd: b.periodEnd,
        generatedBy: b.generatedBy,
        summary: b.summary
      }))
    }, '结算账单列表查询成功', res);
  } catch (err) {
    console.error('listSettlementBills error:', err);
    return error('查询结算账单列表失败：' + err.message, 500, null, res);
  }
}

function getSpaceConflicts(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId, status } = req.query;
    if (!spaceId || !userId) return badRequest('缺少必要参数：spaceId, userId', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'viewer');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    let conflicts = getSharedSpaceConflicts(spaceId);
    if (status) conflicts = conflicts.filter(c => c.status === status);

    return success({
      spaceId,
      totalCount: conflicts.length,
      pendingCount: conflicts.filter(c => c.status === 'pending').length,
      conflicts
    }, '操作冲突查询成功', res);
  } catch (err) {
    console.error('getSpaceConflicts error:', err);
    return error('查询操作冲突失败：' + err.message, 500, null, res);
  }
}

function resolveConflict(req, res) {
  try {
    const { spaceId, conflictId } = req.params;
    const { userId, resolution } = req.body;
    if (!spaceId || !conflictId || !userId || !resolution) {
      return badRequest('缺少必要参数：spaceId, conflictId, userId, resolution', null, res);
    }

    const access = requireSpaceAccess(spaceId, userId, 'admin');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const result = resolveSharedSpaceConflict(spaceId, conflictId, resolution, userId);
    if (!result) return notFound('冲突记录不存在', null, res);

    return success({ conflictId: result.conflictId, status: result.status, resolution: result.resolution, resolvedAt: result.resolvedAt, resolvedBy: result.resolvedBy }, '冲突已解决', res);
  } catch (err) {
    console.error('resolveConflict error:', err);
    return error('解决冲突失败：' + err.message, 500, null, res);
  }
}

function listVersionSnapshots(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId } = req.query;
    if (!spaceId || !userId) return badRequest('缺少必要参数：spaceId, userId', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'viewer');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const snapshots = getSharedSpaceSnapshots(spaceId);
    return success({
      spaceId,
      currentVersion: access.space.currentVersion || 1,
      totalVersions: snapshots.length,
      versions: snapshots.map(s => ({
        version: s.version,
        createdAt: s.createdAt,
        memberCount: s.members.filter(m => m.status === 'active').length,
        recordCount: s.records.length,
        planCount: s.plans.length,
        billCount: s.bills.length
      }))
    }, '历史版本列表查询成功', res);
  } catch (err) {
    console.error('listVersionSnapshots error:', err);
    return error('查询历史版本失败：' + err.message, 500, null, res);
  }
}

function previewRollback(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId, toVersion } = req.query;
    if (!spaceId || !userId || !toVersion) return badRequest('缺少必要参数：spaceId, userId, toVersion', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'admin');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const snapshots = getSharedSpaceSnapshots(spaceId);
    const target = snapshots.find(s => s.version === Number(toVersion));
    if (!target) return notFound('目标版本不存在', null, res);

    const currentRecords = getSharedSpaceRecords(spaceId);
    const currentMembers = getMembers(spaceId);
    const currentPlans = getSharedSpacePlans(spaceId);

    const diff = {
      members: {
        currentCount: currentMembers.filter(m => m.status === 'active').length,
        targetCount: target.members.filter(m => m.status === 'active').length,
        willBeAdded: target.members.filter(tm => !currentMembers.find(cm => cm.userId === tm.userId && cm.status === 'active')).map(m => m.userId),
        willBeRemoved: currentMembers.filter(cm => cm.status === 'active' && !target.members.find(tm => tm.userId === cm.userId && tm.status === 'active')).map(m => m.userId)
      },
      records: {
        currentCount: currentRecords.length,
        targetCount: target.records.length,
        diffCount: currentRecords.length - target.records.length
      },
      plans: {
        currentCount: currentPlans.length,
        targetCount: target.plans.length
      }
    };

    return success({
      spaceId,
      currentVersion: access.space.currentVersion || 1,
      targetVersion: Number(toVersion),
      targetCreatedAt: target.createdAt,
      rollbackPreview: diff,
      note: '此为回滚预览，确认后将执行回滚操作并生成事件日志'
    }, '回滚预览生成成功', res);
  } catch (err) {
    console.error('previewRollback error:', err);
    return error('生成回滚预览失败：' + err.message, 500, null, res);
  }
}

function executeRollback(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId, toVersion } = req.body;
    if (!spaceId || !userId || !toVersion) return badRequest('缺少必要参数：spaceId, userId, toVersion', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'owner');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const targetVersion = Number(toVersion);
    const snapshots = getSharedSpaceSnapshots(spaceId);
    if (!snapshots.find(s => s.version === targetVersion)) {
      return notFound('目标版本不存在', null, res);
    }

    const result = rollbackSharedSpace(spaceId, targetVersion);
    return success({
      spaceId,
      rolledBackToVersion: targetVersion,
      rolledBackAt: new Date().toISOString(),
      restoredMembersCount: result.members.filter(m => m.status === 'active').length,
      restoredRecordsCount: result.records.length
    }, `已回滚到版本 v${targetVersion}，通过事件日志回放保证状态一致性`, res);
  } catch (err) {
    console.error('executeRollback error:', err);
    return error('执行回滚失败：' + err.message, 500, null, res);
  }
}

function backfillSpaceRecord(req, res) {
  try {
    const { spaceId } = req.params;
    const { userId, type, productId, quantity, cyclePhase, timestamp, note, amount, borrowedFrom, borrowedTo, borrowId } = req.body;

    if (!spaceId || !userId || !type || !timestamp) return badRequest('缺少必要参数：spaceId, userId, type, timestamp', null, res);
    if (!RECORD_TYPES.includes(type)) return badRequest(`type 必须是: ${RECORD_TYPES.join(', ')}`, null, res);
    if (!isValidDate(timestamp)) return badRequest('timestamp 必须是合法的 ISO 日期字符串', null, res);

    const access = requireSpaceAccess(spaceId, userId, 'collaborator');
    if (access.error) return (access.code === 404 ? notFound : badRequest)(access.error, null, res);

    const recordData = {
      userId,
      productId: productId || null,
      quantity: quantity !== undefined ? quantity : null,
      cyclePhase: cyclePhase || null,
      timestamp,
      note: note || null,
      amount: amount !== undefined ? amount : null,
      borrowedFrom: borrowedFrom || null,
      borrowedTo: borrowedTo || null,
      borrowId: borrowId || null
    };

    const record = addSharedSpaceRecord(spaceId, recordData, type, { backfill: true, source: 'backfill' });
    return success({
      recordId: record.id,
      type: record.type,
      backfill: true,
      cycleAnchorNotAffected: true,
      note: '补录数据已记录，不会污染其他成员的当前周期锚点，通过事件日志回放机制保证各成员状态隔离'
    }, '共享空间历史数据补录成功', res);
  } catch (err) {
    console.error('backfillSpaceRecord error:', err);
    return error('补录历史数据失败：' + err.message, 500, null, res);
  }
}

module.exports = {
  createSpace,
  updateSpace,
  deleteSpace,
  getSpace,
  listUserSpaces,
  inviteSpaceMember,
  joinSpace,
  leaveSpace,
  removeSpaceMember,
  updateSpaceMember,
  reportRecord,
  getSpaceInventoryView,
  getAggregation,
  generateProcurementPlan,
  confirmProcurementPlan,
  listProcurementPlans,
  generateSettlementBill,
  listSettlementBills,
  getSpaceConflicts,
  resolveConflict,
  listVersionSnapshots,
  previewRollback,
  executeRollback,
  backfillSpaceRecord
};
