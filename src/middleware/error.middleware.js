// Translate upload, validation, database, and unexpected failures into HTTP responses.
function errorHandler(error, req, res, next) {
    if (res.headersSent) {
        return next(error);
    }

    if (error.name === 'MulterError') {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ message: 'Image must be 25 MB or smaller' });
        }

        return res.status(400).json({ message: 'Invalid upload. Send one file using the image field.' });
    }

    if (error.name === 'ValidationError' || error.name === 'CastError') {
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

    if (error.name?.includes('Mongo') || error.name?.includes('Mongoose')) {
        console.error('Database request failed:', error.name);
        return res.status(503).json({ message: 'Database unavailable; product was not saved' });
    }

    console.error('Request failed:', error.name);
    console.error(error)
    return res.status(500).json({ message: 'Internal server error' });
}

module.exports = errorHandler;
