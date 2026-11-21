const express = require('express');
const productController = require('../controllers/product.controller');
const multer = require('multer');

const upload = multer({
    storage: multer.memoryStorage(),
});

const router = express.Router();

// Keep existing GridFS-backed image URLs readable for products created before ImageKit.
router.get('/images/:fileId', productController.handleProductRequest);
// Require the image and product fields as multipart form-data for new products.
router.post('/upload', upload.single('image'), productController.handleProductRequest);

router.post('/:productId/view', productController.incrementProductView);
router.get('/', productController.getAllProducts);
router.get('/:productId', productController.getProductById);

module.exports = router;
