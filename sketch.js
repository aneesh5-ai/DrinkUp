// ─────────────────────────────────────────────────────────────
//  DRINK UP — ml5 PoseNet puppet drinking game
//
//  Mechanic:
//    • Raise right wrist to face → attempt to make puppet drink
//    • Puppet resists with decreasing probability as it gets drunker
//    • Drinks 1-5: resist chance = 80% - (drinkCount * 14%)
//    • Drinks 6+: drink always goes through BUT random blackout
//      chance = 40% at drink 6, +40% relative each drink after
//    • Visual state worsens with each drink (sway, blur, red eyes)
// ─────────────────────────────────────────────────────────────

let video, poseNet, poses = [];
let glassScreen = document.getElementById('glassScreen');

const BLACKOUT_DRINKS = 8;
const SIP_COOLDOWN    = 2000;   // ms between attempts
const HOLD_FRAMES     = 8;      // consecutive frames wrist must be near face
const ATTEMPTS_PER_TURN = 2;   // attempts before turn passes

let drinkCount    = 0;
let lastSipTime   = -9999;
let intox         = 0;          // 0‒1 visual drunkenness
let modelReady    = false;

let turnAttempts  = 0;          // attempts used this turn (resets each turn)
let turnOver      = false;      // true briefly while showing "next player" msg
let turnOverEnd   = 0;

// Puppet reaction state
let reaction     = "idle";      // idle | resist | accept | blackout | turnover
let reactionEnd  = 0;
let reactionMsg  = "";
let headDodge    = { x: 0, y: 0 };
let handNearCount = 0;

// Smoothed puppet joints (canvas-space)
let P = {
  head: { x: 0, y: 0 },
  ls:   { x: 0, y: 0 },
  rs:   { x: 0, y: 0 },
  lw:   { x: 0, y: 0 },
  rw:   { x: 0, y: 0 },
};

let isBlackedOut  = false;
let blackoutStart = 0;
let gameOver      = false;

// Resist messages — puppet pushes back
const RESIST_MSGS = [
  "Nah I'm good.",
  "No thanks.",
  "I'll pass.",
  "Not right now.",
  "Stop it.",
  "I said no!",
  "Seriously, stop.",
  "I don't want it.",
];

// Accept messages — puppet caves
const ACCEPT_MSGS = [
  ["Ok fine… just one.", "🍺"],
  ["Alright, alright.", "🍺🍺"],
  ["You win… ugh.", "🍺🍺🍺"],
  ["I shouldn't… but ok.", "🍺🍺🍺🍺"],
  ["This is a bad idea.", "🍺🍺🍺🍺🍺"],
  ["Blacking out is possible now…", "⚠️"],
  ["I feel sick…", "⚠️⚠️"],
  ["Everything is spinning…", "🚨"],
];

// ─────────────────────────────────────────────────────────────
function setup() {
  createCanvas(windowWidth, windowHeight);
  pixelDensity(1);
  textFont("monospace");

  video = createCapture(VIDEO);
  video.size(width, height);

  poseNet = ml5.poseNet(
    video,
    { flipHorizontal: true, maxPoseDetections: 1, scoreThreshold: 0.2, nmsRadius: 20 },
    function() { modelReady = true; }
  );
  poseNet.on("pose", function(r) { poses = r || []; });

  resetPuppetDefault();
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }

function resetPuppetDefault() {
  var cx = width * 0.5, cy = height * 0.5;
  P.head = { x: cx,       y: cy - 180 };
  P.ls   = { x: cx - 90,  y: cy - 60  };
  P.rs   = { x: cx + 90,  y: cy - 60  };
  P.lw   = { x: cx - 140, y: cy + 60  };
  P.rw   = { x: cx + 140, y: cy + 60  };
}

// ─────────────────────────────────────────────────────────────
//  MAIN DRAW
// ─────────────────────────────────────────────────────────────
function draw() {
  var t = millis();

  if (gameOver) {
    drawBlackout(t);
    return;
  }

  updateTracking(t);
  drawBackground(t);
  drawScene(t);
  drawHUD(t);
  drawReactionBubble(t);
  updateBlurEffect();
}

// ─────────────────────────────────────────────────────────────
//  TRACKING & SIP DETECTION
// ─────────────────────────────────────────────────────────────
function updateTracking(t) {
  var pose = poses.length ? poses[0].pose : null;

  if (!pose) {
    easeToDefault(0.04);
    return;
  }

  var mx = width  * 0.15;
  var my = height * 0.10;
  function mapX(x) { return map(x, 0, video.width,  mx, width  - mx); }
  function mapY(y) { return map(y, 0, video.height, my, height - my); }

  function kp(name, minScore) {
    var thresh = (minScore !== undefined) ? minScore : 0.15;
    for (var i = 0; i < pose.keypoints.length; i++) {
      if (pose.keypoints[i].part === name && pose.keypoints[i].score >= thresh)
        return pose.keypoints[i];
    }
    return null;
  }

  var nose = kp("nose");
  var ls   = kp("leftShoulder");
  var rs   = kp("rightShoulder");
  var lw   = kp("leftWrist",  0.10);
  var rw   = kp("rightWrist", 0.10);

  var AMT = 0.18;
  if (nose) easePoint(P.head, mapX(nose.position.x), mapY(nose.position.y), AMT);
  if (ls)   easePoint(P.ls,   mapX(ls.position.x),   mapY(ls.position.y),   AMT);
  if (rs)   easePoint(P.rs,   mapX(rs.position.x),   mapY(rs.position.y),   AMT);
  if (lw)   easePoint(P.lw,   mapX(lw.position.x),   mapY(lw.position.y),   AMT);
  if (rw)   easePoint(P.rw,   mapX(rw.position.x),   mapY(rw.position.y),   AMT);

  // ── Sip attempt detection ──────────────────────────────────
  var sipDist = dist(P.rw.x, P.rw.y, P.head.x, P.head.y);
  var sipZone = 110 + 40 * intox;   // zone grows as puppet gets drunk

  if (sipDist < sipZone) {
    handNearCount++;
  } else {
    handNearCount = 0;
  }

  // Trigger on HOLD_FRAMES consecutive frames AND cooldown elapsed
  if (handNearCount >= HOLD_FRAMES && t - lastSipTime > SIP_COOLDOWN) {
    lastSipTime   = t;
    handNearCount = 0;
    attemptDrink(t);
  }
}

function easePoint(pt, x, y, amt) {
  pt.x = lerp(pt.x, x, amt);
  pt.y = lerp(pt.y, y, amt);
}

function easeToDefault(amt) {
  var cx = width * 0.5, cy = height * 0.5;
  easePoint(P.head, cx,       cy - 180, amt);
  easePoint(P.ls,   cx - 90,  cy - 60,  amt);
  easePoint(P.rs,   cx + 90,  cy - 60,  amt);
  easePoint(P.lw,   cx - 140, cy + 60,  amt);
  easePoint(P.rw,   cx + 140, cy + 60,  amt);
}

// ─────────────────────────────────────────────────────────────
//  DRINK LOGIC
// ─────────────────────────────────────────────────────────────
function attemptDrink(t) {
  // Block attempts while turn-over message is showing
  if (turnOver) return;

  turnAttempts++;

  // ── Blackout check (drinks 6+) ──────────────────────────
  if (drinkCount >= 5) {
    var drinksOver5  = drinkCount - 4;
    var blackoutProb = 1 - Math.pow(0.6, drinksOver5); // 40%, 64%, 78%
    if (Math.random() < blackoutProb) {
      triggerBlackout(t);
      return;
    }
  }

  // ── 50 / 50 resist ──────────────────────────────────────
  if (Math.random() < 0.5) {
    // Puppet resists
    reaction    = "resist";
    reactionEnd = t + 1400;
    var dodgeDir = (P.rw.x > P.head.x) ? -1 : 1;
    headDodge    = { x: dodgeDir * 55, y: -15 };
    setTimeout(function() { headDodge = { x: 0, y: 0 }; }, 700);

    if (turnAttempts >= ATTEMPTS_PER_TURN) {
      // Both attempts used and both resisted — pass turn
      reactionMsg = RESIST_MSGS[Math.floor(Math.random() * RESIST_MSGS.length)] + " (turn over!)";
      setTimeout(function() { endTurn(t); }, 1500);
    } else {
      // First attempt resisted — one attempt left
      reactionMsg = RESIST_MSGS[Math.floor(Math.random() * RESIST_MSGS.length)] + " (1 try left)";
    }

  } else {
    // Puppet accepts — drink goes through, turn ends
    drinkCount++;
    intox        = min(1, intox + 0.14 + drinkCount * 0.02);
    reaction     = "accept";
    reactionEnd  = t + 2000;
    var msgPair  = ACCEPT_MSGS[min(drinkCount - 1, ACCEPT_MSGS.length - 1)];
    reactionMsg  = msgPair[1] + "  " + msgPair[0];
    headDodge    = { x: 0, y: 18 };
    setTimeout(function() { headDodge = { x: 0, y: 0 }; }, 600);
    // Reset turn after drink succeeds
    setTimeout(function() { endTurn(t); }, 2200);
  }
}

function endTurn(t) {
  turnAttempts = 0;
  turnOver     = true;
  turnOverEnd  = millis() + 2200;
  reaction     = "turnover";
  reactionMsg  = "⏭  Next player's turn!";
  reactionEnd  = turnOverEnd;
  setTimeout(function() {
    turnOver    = false;
    reaction    = "idle";
    reactionMsg = "";
  }, 2200);
}

function triggerBlackout(t) {
  reaction      = "blackout";
  reactionEnd   = t + 1000;
  reactionMsg   = "🚨 Blacked out.";
  isBlackedOut  = true;
  if (typeof window.setGameOver === "function") window.setGameOver();
  blackoutStart = t;
  setTimeout(function() { gameOver = true; }, 3500);
}

// ─────────────────────────────────────────────────────────────
//  BACKGROUND
// ─────────────────────────────────────────────────────────────
function drawBackground(t) {
  // Colour shifts from cool blue → warm purple → red as intox rises
  var r = lerp(14,  45,  intox);
  var g = lerp(16,  8,   intox);
  var b = lerp(28,  18,  intox);
  background(r, g, b);

  // Subtle animated gradient blobs
  noStroke();
  var blobAlpha = lerp(15, 55, intox);
  drawNeonBlob(width * 0.18, height * 0.22, 180, blobAlpha, t);
  drawNeonBlob(width * 0.82, height * 0.28, 200, blobAlpha, t + 999);

  if (intox > 0.3) drawRain(t, floor(lerp(0, 45, intox)));
}

function drawNeonBlob(x, y, r, alpha, t) {
  push(); translate(x + sin(t*0.001)*12, y + cos(t*0.0013)*10);
  for (var i = 0; i < 7; i++) {
    fill(lerp(120, 200, intox) + i*6, 55+i*7, 255, alpha * (1 - i/7));
    ellipse(0, 0, r*(1-i/7), r*(1-i/7));
  }
  pop();
}

function drawRain(t, n) {
  stroke(200, 200, 255, 28);
  for (var i = 0; i < n; i++) {
    var x = (i*97 + t*0.18) % width;
    var y = (i*193 + t*0.72) % height;
    line(x, y, x+3, y+15);
  }
  noStroke();
}

// ─────────────────────────────────────────────────────────────
//  SCENE
// ─────────────────────────────────────────────────────────────
function drawScene(t) {
  // Sway increases with intox
  var sway    = intox * 0.22 * sin(t * 0.002 + 0.5);
  var mx      = (P.ls.x + P.rs.x) * 0.5;
  var my      = (P.ls.y + P.rs.y) * 0.5;
  var hipY    = my + 200;

  push();
  translate(mx, hipY); rotate(sway); translate(-mx, -hipY);

  // Ghost double when very drunk
  if (intox > 0.55) {
    var dx = sin(t*0.009) * 8 * intox;
    var dy = cos(t*0.011) * 6 * intox;
    push(); translate(dx, dy); drawPuppet(t, 0.22); pop();
  }

  drawPuppet(t, 1.0);
  pop();
}

// ─────────────────────────────────────────────────────────────
//  PUPPET
// ─────────────────────────────────────────────────────────────
function drawPuppet(t, alphaMul) {
  var mx = (P.ls.x + P.rs.x) * 0.5;
  var my = (P.ls.y + P.rs.y) * 0.5;

  var shoulderW = max(60, dist(P.ls.x, P.ls.y, P.rs.x, P.rs.y));
  var torsoW    = shoulderW * 1.1;
  var torsoH    = torsoW * 1.55;
  var headR     = torsoW * 0.38;

  // Body colour shifts with intox: blue → purple
  var sR = lerp(100, 160, intox);
  var sG = lerp(140, 60,  intox);
  var sB = lerp(200, 140, intox);

  noStroke();

  // Torso
  fill(sR, sG, sB, 210 * alphaMul);
  rectMode(CENTER);
  rect(mx, my + torsoH * 0.5, torsoW, torsoH, 14);

  // Head — apply dodge offset
  var hx = P.head.x + headDodge.x;
  var hy = P.head.y + headDodge.y;

  // Skin
  fill(245, 220, 185, 230 * alphaMul);
  ellipse(hx, hy, headR * 2, headR * 2);

  // Hair
  fill(55, 35, 15, 210 * alphaMul);
  arc(hx, hy - headR * 0.1, headR * 2.1, headR * 1.4, PI, TWO_PI);

  // Eyes
  var eyeOpen = max(0.08, 1.0 - intox * 0.85);
  var blink   = 0.85 + 0.15 * sin(t * 0.007 + 2);
  var lidH    = max(0.06, eyeOpen * blink);
  var ex      = headR * 0.28;
  var ey      = headR * 0.08;

  fill(255, 255, 255, 230 * alphaMul);
  ellipse(hx - ex, hy - ey, headR * 0.33, headR * 0.33 * lidH);
  ellipse(hx + ex, hy - ey, headR * 0.33, headR * 0.33 * lidH);

  fill(30, 30, 80, 240 * alphaMul);
  ellipse(hx - ex, hy - ey, headR * 0.17, headR * 0.17 * lidH);
  ellipse(hx + ex, hy - ey, headR * 0.17, headR * 0.17 * lidH);

  // Red eyes from intox
  if (intox > 0.3) {
    fill(255, 50, 50, map(intox, 0.3, 1.0, 0, 85) * alphaMul);
    ellipse(hx - ex, hy - ey, headR * 0.33, headR * 0.33 * lidH);
    ellipse(hx + ex, hy - ey, headR * 0.33, headR * 0.33 * lidH);
  }

  // Mouth — sober=smile, drunk=frown, very drunk=open
  noFill();
  stroke(140, 75, 55, 210 * alphaMul);
  strokeWeight(3);
  var mW = headR * 0.52;
  var mY = hy + headR * 0.32;

  if (intox < 0.25) {
    arc(hx, mY, mW, mW * 0.5, 0, PI);                        // smile
  } else if (intox < 0.65) {
    arc(hx, mY + 5, mW * 0.9, mW * 0.55, PI, TWO_PI);        // frown
  } else {
    noStroke();
    fill(100, 45, 30, 200 * alphaMul);
    ellipse(hx, mY + 6, mW * 0.5, mW * 0.38);                 // open mouth
  }
  noStroke();

  // Arms
  stroke(sR, sG, sB, 200 * alphaMul);
  strokeWeight(max(9, torsoW * 0.17));
  strokeCap(ROUND);
  line(P.ls.x, P.ls.y, P.lw.x, P.lw.y);
  line(P.rs.x, P.rs.y, P.rw.x, P.rw.y);

  // Hands
  noStroke();
  fill(245, 220, 185, 210 * alphaMul);
  ellipse(P.lw.x, P.lw.y, 20, 20);
  ellipse(P.rw.x, P.rw.y, 20, 20);

  // Cup in right hand
  drawCup(P.rw.x, P.rw.y, alphaMul);
}

function drawCup(cx, cy, alphaMul) {
  push(); rectMode(CENTER);
  fill(255, 255, 255, 175 * alphaMul);
  rect(cx, cy - 2, 24, 32, 5);
  var level = max(0.05, 1 - drinkCount / BLACKOUT_DRINKS);
  fill(255, 200, 80, 165 * alphaMul);
  var liqH = 22 * level;
  rect(cx, cy + 16 - liqH * 0.5, 18, liqH, 3);
  stroke(255, 120, 120, 185 * alphaMul);
  strokeWeight(2.5);
  line(cx + 5, cy - 17, cx + 8, cy + 13);
  pop();
}

// ─────────────────────────────────────────────────────────────
//  REACTION BUBBLE
// ─────────────────────────────────────────────────────────────
function drawReactionBubble(t) {
  if (t > reactionEnd || reactionMsg === "") return;

  var progress = (reactionEnd - t) / 1800;
  var fade     = min(1, progress * 3, (1 - progress) * 6 + 0.1);

  var bx = P.head.x + headDodge.x;
  var by = P.head.y + headDodge.y - 80;

  push();
  textSize(18);
  var tw = textWidth(reactionMsg);
  var bw = tw + 28, bh = 44, br = 12;
  var tx = bx - bw * 0.5, ty = by - bh * 0.5;

  // Bubble background
  var bubbleCol = reaction === "resist"   ? color(220, 50, 50,   200 * fade)
                : reaction === "turnover" ? color(60,  120, 220, 200 * fade)
                :                           color(40,  180, 100, 200 * fade);
  fill(bubbleCol);
  rect(tx, ty, bw, bh, br);
  fill(bubbleCol);
  triangle(bx - 8, ty + bh - 1, bx + 8, ty + bh - 1, bx, ty + bh + 14);

  // Text
  fill(255, 240 * fade);
  textAlign(CENTER, CENTER);
  text(reactionMsg, bx, by);
  pop();
}

// ─────────────────────────────────────────────────────────────
//  HUD
// ─────────────────────────────────────────────────────────────
function drawHUD(t) {
  // Drink pips
  var pip = 20, gap = 7, ox = 20, py = height - 36;
  for (var i = 0; i < BLACKOUT_DRINKS; i++) {
    noStroke();
    if (i < drinkCount) {
      fill(i >= 5 ? color(255, 60, 60) : color(80, 200, 120));
    } else {
      fill(255, 255, 255, 40);
    }
    ellipse(ox + i * (pip + gap) + pip * 0.5, py, pip, pip);
  }

  // Instruction
  fill(255, 150);
  textSize(13);
  textAlign(LEFT, TOP);
  noStroke();

  var attemptsLeft = ATTEMPTS_PER_TURN - turnAttempts;
  var instrY = height - 60;
  if (turnOver) {
    fill(100, 160, 255, 220);
    text("⏭  Pass to next player!", ox, instrY);
  } else if (drinkCount < 5) {
    text("✋ Offer a sip  |  attempts left this turn: " + attemptsLeft, ox, instrY);
  } else {
    text("⚠️  Danger zone — attempts left this turn: " + attemptsLeft, ox, instrY);
  }

  // Drunk-o-meter bar (top right)
  var bw = 140, bh = 14, bx = width - bw - 20, by2 = 20;
  fill(255, 255, 255, 30);
  rect(bx, by2, bw, bh, 4);
  fill(lerp(80, 255, intox), lerp(200, 60, intox), lerp(120, 60, intox), 210);
  rect(bx, by2, bw * intox, bh, 4);
  fill(255, 180);
  textSize(11);
  textAlign(RIGHT, TOP);
  text("intox", width - 20, by2 + bh + 4);

  // Model status
  if (!modelReady) {
    fill(255, 200, 0, 200);
    textAlign(CENTER, TOP);
    textSize(14);
    text("⏳ Loading pose model…", width * 0.5, 20);
  }
}

// ─────────────────────────────────────────────────────────────
//  BLACKOUT END SCREEN
// ─────────────────────────────────────────────────────────────
function drawBlackout(t) {
  var age  = t - blackoutStart;
  var fade = constrain(age / 3000, 0, 1);

  background(0);
  fill(0, 255 * fade);
  rect(0, 0, width, height);

  if (age > 1500) {
    var textFade = constrain((age - 1500) / 1500, 0, 1);
    push();
    textAlign(CENTER, CENTER);
    fill(255, 255 * textFade);
    textSize(36);
    text("Blacked out.", width * 0.5, height * 0.38);
    textSize(18);
    fill(200, 180 * textFade);
    text("after " + drinkCount + " drink" + (drinkCount === 1 ? "" : "s"), width * 0.5, height * 0.48);
    textSize(22);
    fill(255, 80, 80, 220 * textFade);
    text("Current player loses!", width * 0.5, height * 0.57);
    textSize(14);
    fill(160, 140 * textFade);
    text("refresh to play again", width * 0.5, height * 0.67);
    pop();
  }
}

// ─────────────────────────────────────────────────────────────
//  BLUR EFFECT
// ─────────────────────────────────────────────────────────────
function updateBlurEffect() {
  if (glassScreen) {
    glassScreen.style.backdropFilter = "blur(" + (intox * 10) + "px)";
  }
}
