const express = require("express");
const {
  deleteGameProgress,
  getGameProgress,
  saveGameProgress,
} = require("../controllers/gameProgressController");
const { authenticate } = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/progress", authenticate, getGameProgress);
router.put("/progress", authenticate, saveGameProgress);
router.delete("/progress", authenticate, deleteGameProgress);

module.exports = router;
