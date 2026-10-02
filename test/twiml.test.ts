import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConversationRelayTwiml,
  type ConversationRelayTwimlOptions,
  type SpeechToTextConfig,
  type TextToSpeechConfig,
} from "../src/index.js";

const BASE: ConversationRelayTwimlOptions = {
  streamUrl: "wss://relay.example.test/calls/fictional",
  stt: { provider: "Deepgram", model: "nova-3-general" },
  tts: { provider: "ElevenLabs", voice: "fictional-voice" },
};

test("speech_configuration_supports_twilio_provider_choices", () => {
  const recognizers: SpeechToTextConfig[] = [
    { provider: "Google", model: "telephony" },
    { provider: "Deepgram", model: "nova-3-general" },
  ];
  const speakers: TextToSpeechConfig[] = [
    { provider: "Google", voice: "en-US-Journey-D" },
    { provider: "Amazon", voice: "Matthew" },
    { provider: "ElevenLabs", voice: "fictional-voice" },
  ];
  for (const stt of recognizers) {
    for (const tts of speakers) {
      const xml = buildConversationRelayTwiml({ ...BASE, stt, tts });
      assert.ok(xml.includes(`transcriptionProvider="${stt.provider}"`));
      assert.ok(xml.includes(`speechModel="${stt.model}"`));
      assert.ok(xml.includes(`ttsProvider="${tts.provider}"`));
      assert.ok(xml.includes(`voice="${tts.voice}"`));
      assert.ok(xml.includes('language="en-US"'));
      assert.ok(xml.startsWith("<Response><Connect><ConversationRelay "));
      assert.ok(xml.endsWith(" /></Connect><Hangup/></Response>"));
      assert.doesNotMatch(xml, /partialPrompts/);
    }
  }
});

test("twiml_escapes_attribute_text_and_farewell_without_xml_injection", () => {
  const xml = buildConversationRelayTwiml({
    ...BASE,
    streamUrl: 'wss://relay.example.test/calls/fictional?a=1&b="x"',
    greeting: 'Hello <reader> & "friend"\'s guest',
    endMessage: 'Goodbye </Say><Redirect> & "reader"\'s friend',
    tts: { provider: "ElevenLabs", voice: 'voice<&>"\'' },
  });
  assert.ok(xml.includes('url="wss://relay.example.test/calls/fictional?a=1&amp;b=&quot;x&quot;"'));
  assert.ok(xml.includes('welcomeGreeting="Hello &lt;reader&gt; &amp; &quot;friend&quot;&apos;s guest"'));
  assert.ok(xml.includes('voice="voice&lt;&amp;&gt;&quot;&apos;"'));
  assert.ok(xml.includes('<Say>Goodbye &lt;/Say&gt;&lt;Redirect&gt; &amp; &quot;reader&quot;&apos;s friend</Say>'));
  assert.doesNotMatch(xml, /<Redirect>|<reader>/);
});

test("twiml_rejects_unsafe_stream_urls", () => {
  for (const streamUrl of [
    "http://relay.example.test/call", "https://relay.example.test/call",
    "ws://relay.example.test/call", "javascript:alert(1)",
    "wss://user:password@relay.example.test/call", "wss://user@relay.example.test/call",
    "wss://relay.example.test/call#fragment", "/relative-call", "",
  ]) {
    assert.throws(() => buildConversationRelayTwiml({ ...BASE, streamUrl }), TypeError);
  }
});

test("twiml_rejects_unsupported_providers_and_blank_speech_identifiers", () => {
  assert.throws(() => buildConversationRelayTwiml({
    ...BASE, stt: { provider: "ArbitrarySTT", model: "custom" } as unknown as SpeechToTextConfig,
  }), /Unsupported/);
  assert.throws(() => buildConversationRelayTwiml({
    ...BASE, tts: { provider: "ArbitraryTTS", voice: "custom" } as unknown as TextToSpeechConfig,
  }), /Unsupported/);
  assert.throws(() => buildConversationRelayTwiml({ ...BASE, stt: { ...BASE.stt, model: "  " } }), /nonempty/);
  assert.throws(() => buildConversationRelayTwiml({ ...BASE, tts: { ...BASE.tts, voice: "  " } }), /nonempty/);
});

test("twiml_disables_partial_prompts_only_for_deepgram_flux", () => {
  const xml = buildConversationRelayTwiml({ ...BASE, stt: { provider: "Deepgram", model: "flux" } });
  assert.ok(xml.includes('partialPrompts="false"'));
  assert.doesNotMatch(buildConversationRelayTwiml(BASE), /partialPrompts/);
  assert.doesNotMatch(buildConversationRelayTwiml({ ...BASE, stt: { provider: "Google", model: "telephony" } }), /partialPrompts/);
});

test("twiml_preserves_language_overrides_and_rejects_unsupported_multilingual_choices", () => {
  const xml = buildConversationRelayTwiml({
    ...BASE, language: "en-GB",
    stt: { ...BASE.stt, language: "multi" },
    tts: { ...BASE.tts, language: "multi" },
  });
  assert.ok(xml.includes('language="en-GB"'));
  assert.ok(xml.includes('transcriptionLanguage="multi"'));
  assert.ok(xml.includes('ttsLanguage="multi"'));
  assert.throws(() => buildConversationRelayTwiml({
    ...BASE, language: "multi", stt: { provider: "Google", model: "telephony" },
  }), /Multilingual transcription/);
  assert.throws(() => buildConversationRelayTwiml({
    ...BASE, language: "multi", tts: { provider: "Amazon", voice: "Matthew" },
  }), /Multilingual synthesis/);
});
