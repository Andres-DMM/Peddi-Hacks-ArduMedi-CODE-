/*
  ArduMedi Project
  Peddie Hacks Hackathon

  Reads:
    -MAX30102   heart rate (PBA algorithm)
    - DHT11                 temperature + humidity
    - MQ (gas) sensor       air quality as a percentage

  Push the button to start measuring your heart rate; release it to stop.
  The web dashboard (Web Serial API) parses the serial output below.

  Wiring (Arduino Uno):
    MAX3010x : VIN -> 3.3V   GND -> GND   SDA -> A4   SCL -> A5
    DHT11    : VCC -> 5V   GND -> GND   DAT -> pin 3
    Gas      : VCC -> 5V   GND -> GND   A0  -> A0
    Button   : pin 2  -> GND (INPUT_PULLUP, pressed = LOW)
    LED      : pin 13 (onboard, lights while measuring)

  Serial protocol (115200 baud):
    M,1         measuring started (button pressed)
    M,0         measuring stopped (button released)
    E,h,t,g     environment snapshot: humidity %, temp C, gas %
    R,ir        raw IR reading while measuring
    B,bpm,avg   a heartbeat was detected

  Libraries (Arduino Library Manager):
    - SparkFun MAX3010x Pulse and Proximity Sensor Library
    - DHT sensor library (Adafruit)
*/

#include <Wire.h>
#include <MAX30105.h>
#include <heartRate.h>
#include <DHT.h>

// ---------------- Pin definitions ----------------
#define BUTTON_PIN 2
#define DHTPIN     3
#define GAS_PIN    A0
#define LED_PIN    13

#define DHTTYPE DHT11

// ---------------- Objects ----------------
MAX30105 particleSensor;
DHT dht(DHTPIN, DHTTYPE);

// ---------------- Heart rate state (PBA) ----------------
const byte RATE_SIZE = 4;    // more = smoother average
byte rates[RATE_SIZE];
byte rateSpot = 0;
long lastBeat = 0;
float beatsPerMinute = 0;
int beatAvg = 0;

// ---------------- Timing ----------------
const unsigned long ENV_INTERVAL = 2000;   // DHT11 needs 2s between reads
const unsigned long IR_INTERVAL  = 50;     // raw reading throttle in ms
const unsigned long DEBOUNCE_MS  = 30;

unsigned long lastEnvTime = 0;
unsigned long lastIRTime = 0;
unsigned long lastDebounceTime = 0;
bool lastButtonState = HIGH;

// ---------------- State ----------------
bool measuring = false;

// ============================================================
// SETUP
// ============================================================
void setup() {
  Serial.begin(115200);

  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(GAS_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);

  dht.begin();

  if (!particleSensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("FATAL,MAX3010x not found - check wiring/power.");
    while (1);
  }

  particleSensor.setup();                 // default settings
  particleSensor.setPulseAmplitudeRed(0x0A); // low red LED = running
  particleSensor.setPulseAmplitudeGreen(0);  // green LED off

  Serial.println("ArduMedi ready - press the button to measure.");
}

// ============================================================
// MAIN LOOP
// ============================================================
void loop() {
  updateButton();

  if (measuring) {
    measureHeartRate();
  }

  if (millis() - lastEnvTime >= ENV_INTERVAL) {
    lastEnvTime = millis();
    sendEnvironment();
  }
}

// ============================================================
// BUTTON (debounced, pressed = LOW because INPUT_PULLUP)
// ============================================================
void updateButton() {
  bool buttonState = (digitalRead(BUTTON_PIN) == LOW);

  if (buttonState != lastButtonState) {
    lastDebounceTime = millis();
    lastButtonState = buttonState;
  }

  if (millis() - lastDebounceTime >= DEBOUNCE_MS && measuring != buttonState) {
    measuring = buttonState;
    digitalWrite(LED_PIN, measuring ? HIGH : LOW);

    if (measuring) {
      resetHeartRate();
      Serial.println("M,1");
    } else {
      Serial.println("M,0");
    }
  }
}

// ============================================================
// HEART RATE (MAX3010x, PBA algorithm)
// ============================================================
void measureHeartRate() {
  long irValue = particleSensor.getIR();

  // Send the raw reading so the web can show live data (throttled).
  if (millis() - lastIRTime >= IR_INTERVAL) {
    lastIRTime = millis();
    Serial.print("R,");
    Serial.println(irValue);
  }

  if (checkForBeat(irValue)) {
    long delta = millis() - lastBeat;
    lastBeat = millis();

    beatsPerMinute = 60 / (delta / 1000.0);

    if (beatsPerMinute < 255 && beatsPerMinute > 20) {
      rates[rateSpot++] = (byte)beatsPerMinute; // store this reading
      rateSpot %= RATE_SIZE;                    // wrap around

      // average of the last readings
      beatAvg = 0;
      for (byte x = 0; x < RATE_SIZE; x++) {
        beatAvg += rates[x];
      }
      beatAvg /= RATE_SIZE;

      Serial.print("B,");
      Serial.print((int)beatsPerMinute);
      Serial.print(",");
      Serial.println(beatAvg);
    }
  }
}

// Clear heart rate state for a fresh measurement session.
void resetHeartRate() {
  rateSpot = 0;
  lastBeat = millis();
  beatsPerMinute = 0;
  beatAvg = 0;
  for (byte x = 0; x < RATE_SIZE; x++) {
    rates[x] = 0;
  }
}

// ============================================================
// ENVIRONMENT (DHT11 + gas sensor)
// ============================================================
void sendEnvironment() {
  float h = dht.readHumidity();
  float t = dht.readTemperature();

  if (isnan(h) || isnan(t)) {
    Serial.println("E,DHT_ERROR,0,0");
    return;
  }

  Serial.print("E,");
  Serial.print(h);
  Serial.print(",");
  Serial.print(t);
  Serial.print(",");
  Serial.println(readGasPercentage());
}

int readGasPercentage() {
  int raw = analogRead(GAS_PIN);
  return constrain(map(raw, 0, 1023, 0, 100), 0, 100);
}
