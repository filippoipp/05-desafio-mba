import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1792000000000 implements MigrationInterface {
  name = 'CreateVideos1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL, "channel_id" uuid NOT NULL, "title" character varying(200) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'draft', "public_id" character varying(16) NOT NULL, "source_key" character varying(512) NOT NULL, "thumbnail_key" character varying(512), "upload_id" character varying(256), "declared_size_bytes" bigint NOT NULL, "part_size_bytes" integer NOT NULL, "duration_seconds" double precision, "metadata" jsonb, "processing_error" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_videos" PRIMARY KEY ("id"), CONSTRAINT "UQ_videos_public_id" UNIQUE ("public_id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_videos_channel_id" ON "videos" ("channel_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_videos_channel" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_videos_channel"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_videos_channel_id"`);
    await queryRunner.query(`DROP TABLE "videos"`);
  }
}
