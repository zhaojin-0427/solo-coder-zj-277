const express = require('express');
const router = express.Router();
const {
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
} = require('../controllers/sharingController');

router.post('/spaces', createSpace);
router.put('/spaces/:spaceId', updateSpace);
router.delete('/spaces/:spaceId', deleteSpace);
router.get('/spaces/:spaceId', getSpace);
router.get('/spaces/user/:userId', listUserSpaces);

router.post('/spaces/:spaceId/members/invite', inviteSpaceMember);
router.post('/spaces/:spaceId/members/join', joinSpace);
router.post('/spaces/:spaceId/members/leave', leaveSpace);
router.post('/spaces/:spaceId/members/remove', removeSpaceMember);
router.put('/spaces/:spaceId/members', updateSpaceMember);

router.post('/spaces/:spaceId/records', reportRecord);
router.post('/spaces/:spaceId/records/backfill', backfillSpaceRecord);

router.get('/spaces/:spaceId/inventory', getSpaceInventoryView);
router.get('/spaces/:spaceId/aggregation', getAggregation);

router.post('/spaces/:spaceId/plans/generate', generateProcurementPlan);
router.post('/spaces/:spaceId/plans/:planId/confirm', confirmProcurementPlan);
router.get('/spaces/:spaceId/plans', listProcurementPlans);

router.post('/spaces/:spaceId/bills/generate', generateSettlementBill);
router.get('/spaces/:spaceId/bills', listSettlementBills);

router.get('/spaces/:spaceId/conflicts', getSpaceConflicts);
router.post('/spaces/:spaceId/conflicts/:conflictId/resolve', resolveConflict);

router.get('/spaces/:spaceId/versions', listVersionSnapshots);
router.get('/spaces/:spaceId/versions/rollback-preview', previewRollback);
router.post('/spaces/:spaceId/versions/rollback', executeRollback);

module.exports = router;
