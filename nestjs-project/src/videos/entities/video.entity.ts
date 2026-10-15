import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { VideoMetadata, VideoStatus } from '../video-status';

@Entity('videos')
@Unique('UQ_videos_public_id', ['public_id'])
export class Video {
  @PrimaryColumn('uuid')
  id: string;

  @Index('IDX_videos_channel_id')
  @Column({ type: 'uuid' })
  channel_id: string;

  @ManyToOne(() => Channel, { onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'varchar', length: 20, default: VideoStatus.Draft })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 16 })
  public_id: string;

  @Column({ type: 'varchar', length: 512 })
  source_key: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  upload_id: string | null;

  @Column({
    type: 'bigint',
    transformer: {
      to: (value: number) => value,
      from: (value: string | null) => (value === null ? 0 : Number(value)),
    },
  })
  declared_size_bytes: number;

  @Column({ type: 'integer' })
  part_size_bytes: number;

  @Column({ type: 'double precision', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
