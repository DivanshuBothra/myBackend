const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const productController = require('../controllers/product.controller');
const requireAuthenticatedUser = require('../middleware/auth.middleware');

const upload = multer({
storage: multer.memoryStorage(),
limits: { fileSize: 10 * 1024 * 1024 }, // max 5 MB image
});

const router = express.Router();

// Max 10 view requests per IP per minute, so nobody can inflate view counts.
const viewLimiter = rateLimit({
windowMs: 60 * 1000,
max: 10,
standardHeaders: true,
legacyHeaders: false,
message: { message: 'Too many requests. Please try again later.' },
});

// Max 20 upload attempts per IP per 15 minutes.
const uploadLimiter = rateLimit({
windowMs: 15 * 60 * 1000,
max: 20,
standardHeaders: true,
legacyHeaders: false,
message: { message: 'Too many upload attempts. Please try again later.' },
});

// Keep existing GridFS-backed image URLs readable for products created before ImageKit.
router.get('/images/:fileId', productController.handleProductRequest);

// Admin product form signs up to five direct-to-ImageKit uploads at once.
router.get('/upload-auth', requireAuthenticatedUser, uploadLimiter, productController.getProductUploadAuth);
router.post('/upload-cleanup', requireAuthenticatedUser, uploadLimiter, productController.cleanupUploadedImages);

// Admin-only product creation (the controller checks token and admin role).
router.post(
'/upload',
requireAuthenticatedUser,
uploadLimiter,
upload.single('image'),
productController.handleProductRequest
);
router.get('/admin/inventory', requireAuthenticatedUser, productController.getInventorySales);
router.patch('/admin/inventory/:productId', requireAuthenticatedUser, productController.adjustInventory);

// Count a product view, rate limited.
router.post('/:productId/view', viewLimiter, productController.incrementProductView);

router.get('/', productController.getAllProducts);
router.get('/:productId', productController.getProductById);

module.exports = router;
