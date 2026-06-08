const express = require('express');
const router = express.Router();
const {
  configureSubscriptionHandler,
  getSubscriptionConfig,
  previewPlan,
  confirmPlanHandler,
  cancelPlanHandler,
  listPlans,
  getPlanDetail,
  comparePlanVersions,
  recalculatePlan,
  backfillReport
} = require('../controllers/subscriptionController');

router.put('/:userId/config', configureSubscriptionHandler);
router.get('/:userId/config', getSubscriptionConfig);

router.get('/:userId/plan/preview', previewPlan);
router.post('/:userId/plan/recalculate', recalculatePlan);
router.get('/:userId/plans', listPlans);
router.get('/:userId/plans/compare', comparePlanVersions);
router.get('/:userId/plans/:planId', getPlanDetail);
router.post('/:userId/plans/:planId/confirm', confirmPlanHandler);
router.post('/:userId/plans/:planId/cancel', cancelPlanHandler);

router.post('/inventory/backfill', backfillReport);

module.exports = router;
