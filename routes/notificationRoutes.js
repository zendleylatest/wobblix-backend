const express = require("express");
const { authenticate, optionalAuth } = require("../middlewares/authMiddleware");
const {
  registerToken,
  sendNotification,
  getTokens,
  removeToken,
  setPreferences,
} = require("../controllers/notificationController");

const router = express.Router();

router.post("/register-token", optionalAuth, registerToken);
router.post("/send", authenticate, sendNotification);
router.put("/preferences", authenticate, setPreferences);
router.get("/tokens", authenticate, getTokens);
router.delete("/tokens/:token", authenticate, removeToken);

module.exports = router;
