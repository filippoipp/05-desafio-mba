import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';
import { createPublicId } from '../public-id';
import { VideoStatus } from '../video-status';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let n = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createChannel(): Promise<Channel> {
    n += 1;
    const user = await users.save(
      users.create({
        email: `video_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channels.save(
      channels.create({
        name: `Channel ${n}`,
        nickname: `chan_${n}`,
        user_id: user.id,
      }),
    );
  }

  function draft(channelId: string, publicId = createPublicId()): Video {
    return videos.create({
      id: randomUUID(),
      channel_id: channelId,
      title: 'Clip',
      public_id: publicId,
      source_key: `videos/${publicId}/source`,
      declared_size_bytes: 12,
      part_size_bytes: 16777216,
    });
  }

  it('defaults status to draft', async () => {
    const channel = await createChannel();
    const saved = await videos.save(draft(channel.id));
    expect(saved.status).toBe(VideoStatus.Draft);
  });

  it('rejects a duplicate public_id', async () => {
    const channel = await createChannel();
    const publicId = createPublicId();
    await videos.save(draft(channel.id, publicId));
    await expect(videos.save(draft(channel.id, publicId))).rejects.toThrow();
  });

  it('rejects an unknown channel_id', async () => {
    await expect(videos.save(draft(randomUUID()))).rejects.toThrow();
  });
});
