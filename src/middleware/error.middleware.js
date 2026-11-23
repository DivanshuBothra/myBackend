const { databaseErrorDetails } = require('../db/db');

// Translate upload, validation, database, and unexpected failures into HTTP responses.
function errorHandler(error, req, res, next) {
    if (res.headersSent) {
        return next(error);
    }

    if (error.name === 'MulterError') {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ message: 'Choose 4 or 5 product photos totaling 25 MB or less.' });
        }

        return res.status(400).json({ message: 'Invalid product photo upload. Choose 4 or 5 images.' });
    }

    if (error.name === 'ValidationError' || error.name === 'CastError') {
        if (req.originalUrl?.startsWith('/api/orders')) {
            const invalidFields = error.name === 'ValidationError'
                ? Object.keys(error.errors || {})
                : [error.path].filter(Boolean);
            console.error('Order validation failed:', error.name, invalidFields);
            return res.status(400).json({ message: 'Order details are invalid. Refresh your cart and check the delivery address.' });
        }
        return res.status(400).json({ message: 'Product details are invalid' });
    }

    if (error.type === 'entity.parse.failed') {
        return res.status(400).json({ message: 'Request body must contain valid JSON' });
    }

    if (error.code === 11000) {
        return res.status(409).json({ message: 'A record with these details already exists' });
    }

    if (
        error.status === 403 &&
        error.message?.toLowerCase().includes('account cannot be authenticated')
    ) {
        console.error('ImageKit rejected the configured private key.');
        const key = process.env.IMAGEKIT_PRIVATE_KEY?.trim() || '';
        return res.status(503).json({
            message: key.startsWith('public_')
                ? 'IMAGEKIT_PRIVATE_KEY contains an ImageKit public key; set the private key in backend/.env.'
                : 'Image storage authentication failed. Check IMAGEKIT_PRIVATE_KEY in backend/.env.'
        });
    }

    if (
        error.name?.includes('Mongo') ||
        error.name?.includes('Mongoose') ||
        error.name === 'DatabaseConfigurationError'
    ) {
        console.error('Database request failed:', databaseErrorDetails(error));
        return res.status(503).json({ message: 'Database unavailable; the request could not be completed' });
    }

    console.error('Request failed:', error.name);
    console.error(error)
    return res.status(500).json({ message: 'Internal server error' });
}

module.exports = errorHandler;
