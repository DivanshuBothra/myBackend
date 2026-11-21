const jwt = require('jsonwebtoken');
const UserModel = require('../models/user.model');
const { getActiveAccountBan, getAccountBanMessage } = require('../account-ban');

async function requireAuthenticatedUser(req, res, next) {
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

    try {
        const user = await UserModel.findById(decoded.id)
            .select('role orderCancellationScore accountBannedUntil orderCancellationResetAt');
        if (!user) {
            return res.status(401).json({ message: 'Please sign in to continue.' });
        }

        if (user.role === 'user') {
            const bannedUntil = await getActiveAccountBan(user);
            if (bannedUntil) {
                res.clearCookie('token', {
                    httpOnly: true,
                    secure: true,
                    sameSite: 'none',
                    path: '/'
                });
                return res.status(403).json({
                    code: 'ACCOUNT_BANNED',
                    bannedUntil,
                    message: getAccountBanMessage(bannedUntil)
                });
            }
        }

        req.authUserId = user._id;
        return next();
    } catch (error) {
        return next(error);
    }
}

module.exports = requireAuthenticatedUser;
