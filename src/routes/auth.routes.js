const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const authController = require('../controllers/auth.controller');
const requireAuthenticatedUser = require('../middleware/auth.middleware');

const router = express.Router();
const parseFormFields = multer().none();
const locationLookupLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many location lookups. Please try again later.' }
});

// Public registration always creates a regular user account.
router.post('/register', parseFormFields, authController.registerUser);
// Verify an account's credentials and issue its authentication cookie.
router.post('/login', parseFormFields, authController.loginUser);
// Verify credentials before displaying OTP; this route does not create a session.
router.post('/verify-credentials', parseFormFields, authController.verifyCredentials);
// Admin direct login is available only to accounts with the stored admin role.
router.post('/admin-login', parseFormFields, authController.adminLoginUser);
router.get('/admin-session', authController.getAdminSession);
router.get('/address', requireAuthenticatedUser, authController.getAddress);
router.put('/address', requireAuthenticatedUser, authController.updateAddress);
router.post('/address/location', requireAuthenticatedUser, locationLookupLimiter, authController.lookupAddressLocation);

router.post("/logout", authController.logout)

module.exports = router;
