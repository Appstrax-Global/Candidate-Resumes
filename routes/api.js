const express = require('express');
const router = express.Router();
const upload = require('../middleware/uploadMiddleware');
const uploadController = require('../controllers/uploadController');

// POST /api/upload - Accepts multipart/form-data with file field named 'documents'
router.post('/upload', upload.array('documents', 1000), uploadController.uploadDocument);

// POST /api/submit - Triggers webhook for selected documents
router.post('/submit', uploadController.submitWebhook);

// GET /api/review-queue - Fetches all review queue entries
router.get('/review-queue', uploadController.getReviewQueue);

// PATCH /api/review-queue/:id/status - Quick status update
router.patch('/review-queue/:id/status', uploadController.updateReviewStatus);

// POST /api/review-queue/:id/save - Save recruiter edits to candidate_data
router.post('/review-queue/:id/save', uploadController.saveReviewChanges);

// POST /api/review-queue/:id/approve - Approve and set status to 'corrected'
router.post('/review-queue/:id/approve', uploadController.approveReview);

// POST /api/review-queue/:id/reject - Reject the review item
router.post('/review-queue/:id/reject', uploadController.rejectReview);

module.exports = router;
