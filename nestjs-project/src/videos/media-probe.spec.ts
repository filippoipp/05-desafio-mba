import { parseProbe } from './media-probe';

describe('parseProbe', () => {
  it('maps duration, codecs, and dimensions', () => {
    const metadata = parseProbe(
      JSON.stringify({
        format: { duration: '1.5', format_name: 'mov,mp4' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 160,
            height: 120,
          },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
      }),
    );

    expect(metadata).toEqual({
      durationSeconds: 1.5,
      width: 160,
      height: 120,
      videoCodec: 'h264',
      audioCodec: 'aac',
      formatName: 'mov,mp4',
    });
  });

  it('returns zeros and nulls when the probe has no streams', () => {
    expect(parseProbe('{}')).toEqual({
      durationSeconds: 0,
      width: null,
      height: null,
      videoCodec: null,
      audioCodec: null,
      formatName: null,
    });
  });
});
