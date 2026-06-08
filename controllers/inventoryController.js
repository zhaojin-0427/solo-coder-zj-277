const { success, badRequest, error } = require('../utils/response');
const { addReport, getReportsByUser, getProduct, cyclePhases, addAnomaly, updateUserPreference } = require('../models/store');
const { detectAnomaly } = require('../utils/consumption');

function isValidDate(str) {
  if (!str) return true;
  if (typeof str !== 'string') return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

function reportInventory(req, res) {
  try {
    const { userId, productId, quantity, cyclePhase, timestamp, note } = req.body;

    if (!userId || !productId || quantity === undefined || quantity === null) {
      return badRequest('缺少必要参数：userId, productId, quantity', null, res);
    }

    if (typeof quantity !== 'number' || quantity < 0) {
      return badRequest('quantity 必须是非负数字', null, res);
    }

    if (!getProduct(productId)) {
      return badRequest(`产品ID不存在: ${productId}，请先确认产品列表`, null, res);
    }

    if (cyclePhase && !cyclePhases.includes(cyclePhase)) {
      return badRequest(`cyclePhase 必须是以下之一: ${cyclePhases.join(', ')}`, null, res);
    }

    if (timestamp !== undefined && timestamp !== null && !isValidDate(timestamp)) {
      return badRequest('timestamp 必须是合法的 ISO 日期字符串，如 2026-06-08T10:00:00Z', null, res);
    }

    if (timestamp) {
      const reportDate = new Date(timestamp);
      const now = new Date();
      if (reportDate.getTime() > now.getTime() + 60 * 1000) {
        return badRequest('timestamp 不能是未来时间', null, res);
      }
    }

    const report = {
      userId,
      productId,
      quantity,
      cyclePhase: cyclePhase || null,
      timestamp: timestamp || new Date().toISOString(),
      note: note || null
    };

    const savedReport = addReport(userId, report);

    const anomaly = detectAnomaly(userId, productId, savedReport);
    if (anomaly) {
      addAnomaly(userId, anomaly);
    }

    if (cyclePhase === 'menstrual') {
      updateUserPreference(userId, { lastMenstrualReported: savedReport.timestamp });
    }

    return success({
      reportId: savedReport.id,
      productName: getProduct(productId).name,
      anomalyDetected: !!anomaly,
      anomaly: anomaly || null
    }, '库存上报成功', res);
  } catch (err) {
    console.error('reportInventory error:', err);
    return error('库存上报失败：' + err.message, 500, null, res);
  }
}

function getInventoryHistory(req, res) {
  try {
    const { userId } = req.params;
    if (!userId) {
      return badRequest('缺少 userId 参数', null, res);
    }

    const reports = getReportsByUser(userId);
    const grouped = {};

    reports.forEach(r => {
      if (!grouped[r.productId]) {
        grouped[r.productId] = {
          productId: r.productId,
          productName: getProduct(r.productId)?.name || r.productId,
          reports: []
        };
      }
      grouped[r.productId].reports.push(r);
    });

    return success({
      userId,
      totalReports: reports.length,
      products: Object.values(grouped)
    }, '查询成功', res);
  } catch (err) {
    console.error('getInventoryHistory error:', err);
    return error('查询失败：' + err.message, 500, null, res);
  }
}

module.exports = {
  reportInventory,
  getInventoryHistory
};
