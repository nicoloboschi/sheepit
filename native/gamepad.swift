// Reads game controllers through macOS (GameController framework) and prints
// one line per button press: a, b, x, y, l, r, zl, zr, up, down, left, right,
// menu, options. Chromium can't see some pads on macOS (Switch Pro), so the
// sheepit server runs this and forwards the lines to the UI.
// Built on demand by src/gamepad.ts with `swiftc`.
import Foundation
import GameController

setvbuf(stdout, nil, _IOLBF, 0)
GCController.shouldMonitorBackgroundEvents = true

func wire(_ c: GCController) {
  guard let g = c.extendedGamepad else { return }
  let buttons: [(String, GCControllerButtonInput?)] = [
    ("a", g.buttonA), ("b", g.buttonB), ("x", g.buttonX), ("y", g.buttonY),
    ("l", g.leftShoulder), ("r", g.rightShoulder),
    ("zl", g.leftTrigger), ("zr", g.rightTrigger),
    ("up", g.dpad.up), ("down", g.dpad.down), ("left", g.dpad.left), ("right", g.dpad.right),
    ("menu", g.buttonMenu), ("options", g.buttonOptions),
  ]
  for (name, button) in buttons {
    button?.pressedChangedHandler = { _, _, pressed in if pressed { print(name) } }
  }
}

NotificationCenter.default.addObserver(forName: .GCControllerDidConnect, object: nil, queue: .main) { n in
  if let c = n.object as? GCController { wire(c) }
}
GCController.controllers().forEach(wire)
// The server holds our stdin; when it goes (restart, crash), so do we.
Thread { while FileHandle.standardInput.availableData.count > 0 {}; exit(0) }.start()
RunLoop.main.run()
