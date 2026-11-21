const jwt = require('jsonwebtoken');

function requireAuthenticatedUser(req, res, next) {
    const token = req.cookies?.token;
    if (!token) {
        return res.status(401).json({ message: 'Please sign in to continue.' });
    }

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return res.status(401).json({ message: 'Please sign in to continue.' });
    }

    if (!decoded.id) {
        return res.status(401).json({ message: 'Please sign in to continue.' });
    }

    req.authUserId = decoded.id;
    return next();
}

module.exports = requireAuthenticatedUser;
